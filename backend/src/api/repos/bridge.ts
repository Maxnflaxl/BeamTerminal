import { q } from '../../db.js';
import { getBlock } from '../../explorer.js';
import { BRIDGES } from '../../services/bridge.js';
import { loadUsdTable } from './usd.js';

// ---------------------------------------------------------------------------
// Read models for /api/bridge/*.
//
// Postgres only — no shader calls and no Etherscan on the request path. The
// indexer owns all of that; these are projections of what it already wrote.
// ---------------------------------------------------------------------------

function scale(raw: string | null, decimals: number): number | null {
  if (raw === null) return null;
  // Amounts are NUMERIC(40,0) strings well past Number.MAX_SAFE_INTEGER in
  // groths, so divide as BigInt first and only then convert for display.
  const neg = raw.startsWith('-');
  const digits = neg ? raw.slice(1) : raw;
  const d = BigInt(digits);
  const div = 10n ** BigInt(decimals);
  const whole = d / div;
  const frac = d % div;
  const val = Number(whole) + Number(frac) / Number(div);
  return neg ? -val : val;
}

export interface BridgeHealthRow {
  bridge: string;
  label: string;
  chain_id: number;
  aid: number;
  eth_pipe: string;
  eth_token: string | null;
  outgoing: { pending: number; relayed: number; failed: number; unknown: number; total: number };
  incoming: { not_delivered: number; unclaimed: number; complete: number; unknown: number; total: number };
  oldest_open_ts: string | null;
  last_message_ts: string | null;
  unclaimed_amount: number | null;
  escrow: { locked: number | null; decimals: number; observed_at: string | null } | null;
  minted: number | null;
  /**
   * USD value of the locked collateral. Priced off the *Beam-side* asset, which
   * is the one we have an on-chain BEAM-quoted pool for — the wrapped asset
   * tracks its collateral 1:1, so that price applies to both sides. Null when
   * no pool prices that asset.
   */
  locked_usd: number | null;
  /** minted / locked. Null when either side is unknown. ~1.0 means fully backed. */
  collateral_ratio: number | null;
  settlement_source: 'etherscan' | 'unavailable';
}

interface StatusAggRow {
  bridge: string; direction: string; status: string; n: string;
  oldest: string | null; newest: string | null;
}

export async function getBridgeHealth(etherscanOn: boolean): Promise<BridgeHealthRow[]> {
  const [agg, escrow, minted, unclaimed, usd] = await Promise.all([
    q<StatusAggRow>(
      `SELECT bridge, direction, status, count(*)::text AS n,
              min(src_ts)::text AS oldest, max(src_ts)::text AS newest
         FROM bridge_messages GROUP BY 1, 2, 3`,
    ),
    q<{
      bridge: string; locked: string; decimals: number; observed_at: string;
      minted: string | null; minted_decimals: number | null;
    }>(
      `SELECT bridge, locked::text, decimals, observed_at::text,
              minted::text, minted_decimals
         FROM bridge_escrow`,
    ),
    q<{ aid: string; emission: string | null; decimals: number }>(
      `SELECT aid::text, emission::text, decimals FROM assets
        WHERE aid = ANY($1::bigint[])`,
      [BRIDGES.map((b) => b.aid)],
    ),
    q<{ bridge: string; total: string | null }>(
      `SELECT bridge, sum(amount)::text AS total
         FROM bridge_messages
        WHERE direction = 'eth2beam' AND status = 'unclaimed'
        GROUP BY 1`,
    ),
    // Never let a pricing failure take down the whole endpoint — the bridge
    // health numbers are useful with or without a USD column.
    loadUsdTable().catch(() => null),
  ]);

  const escrowBy = new Map(escrow.rows.map((r) => [r.bridge, r]));
  const mintedBy = new Map(minted.rows.map((r) => [Number(r.aid), r]));
  const unclaimedBy = new Map(unclaimed.rows.map((r) => [r.bridge, r.total]));

  return BRIDGES.map((b) => {
    const mine = agg.rows.filter((r) => r.bridge === b.key);
    const pick = (dir: string, st: string): number =>
      Number(mine.find((r) => r.direction === dir && r.status === st)?.n ?? 0);

    const outgoing = {
      pending: pick('beam2eth', 'pending'),
      relayed: pick('beam2eth', 'relayed'),
      failed: pick('beam2eth', 'failed'),
      unknown: pick('beam2eth', 'unknown'),
      total: 0,
    };
    outgoing.total = outgoing.pending + outgoing.relayed + outgoing.failed + outgoing.unknown;

    const incoming = {
      not_delivered: pick('eth2beam', 'not_delivered'),
      unclaimed: pick('eth2beam', 'unclaimed'),
      complete: pick('eth2beam', 'complete'),
      unknown: pick('eth2beam', 'unknown'),
      total: 0,
    };
    incoming.total = incoming.not_delivered + incoming.unclaimed + incoming.complete + incoming.unknown;

    const openTimes = mine
      .filter((r) => r.status !== 'complete' && r.status !== 'relayed')
      .map((r) => r.oldest)
      .filter((t): t is string => Boolean(t))
      .sort();
    const newestTimes = mine
      .map((r) => r.newest)
      .filter((t): t is string => Boolean(t))
      .sort();

    const esc = escrowBy.get(b.key);
    const mint = mintedBy.get(b.aid);
    const lockedVal = esc ? scale(esc.locked, esc.decimals) : null;
    // Bridges whose collateral sits on Beam record the minted side explicitly
    // (it's an Ethereum ERC20 supply). For the rest it's the Beam asset's own
    // emission. Using assets.emission for a custody:'beam' bridge would report
    // BEAM's entire emission as if it were bridged.
    const mintedVal = (() => {
      if (esc?.minted !== null && esc?.minted !== undefined) {
        return scale(esc.minted, esc.minted_decimals ?? b.ethDecimals);
      }
      // Bridges whose collateral sits on Beam mint an ERC20 on the EVM side, so
      // their wrapped supply only ever comes from the escrow snapshot. Falling
      // back to assets.emission here would report BEAM's entire 191.5M supply
      // as if the bridge had issued it — which is what happens whenever the
      // snapshot is missing (a transient RPC error is enough).
      if (b.custody === 'beam') return null;
      return mint?.emission ? scale(mint.emission, mint.decimals ?? b.decimals) : null;
    })();

    return {
      bridge: b.key,
      label: b.label,
      chain_id: b.chainId,
      aid: b.aid,
      eth_pipe: b.ethPipe,
      eth_token: b.ethToken,
      outgoing,
      incoming,
      oldest_open_ts: openTimes[0] ?? null,
      last_message_ts: newestTimes[newestTimes.length - 1] ?? null,
      unclaimed_amount: scale(unclaimedBy.get(b.key) ?? null, b.ethDecimals),
      escrow: esc
        ? { locked: lockedVal, decimals: esc.decimals, observed_at: esc.observed_at }
        : null,
      minted: mintedVal,
      locked_usd: (() => {
        if (lockedVal === null) return null;
        const px = usd?.perAid.get(b.aid);
        return px === undefined ? null : lockedVal * px;
      })(),
      collateral_ratio:
        lockedVal !== null && lockedVal > 0 && mintedVal !== null ? mintedVal / lockedVal : null,
      settlement_source: etherscanOn ? 'etherscan' : 'unavailable',
    };
  });
}

export interface BridgeMessageRow {
  bridge: string;
  direction: string;
  msg_id: number;
  status: string;
  amount: number | null;
  relayer_fee: number | null;
  receiver: string | null;
  src_height: number | null;
  src_block: number | null;
  src_ts: string | null;
  src_tx: string | null;
  settle_tx: string | null;
  settle_block: number | null;
  settle_ts: string | null;
}

// Whitelisted sort columns. The table is server-paginated, so sorting has to
// happen here — sorting a page client-side would only reorder the 25 rows the
// server happened to pick.
//
// `amount` sorts on the raw stored value, which is in each side's own units:
// comparing a bDAI amount to a bWBTC one isn't meaningful, but sorting within
// one bridge (the usual case, since the filter is right there) is.
// Table-qualified on purpose. The SELECT list casts amount/msg_id to text, and
// Postgres resolves a bare ORDER BY name to the *output* column — so
// `ORDER BY amount` would sort the text alias lexicographically, putting "99"
// above "115792…". Qualifying forces the numeric table column.
const SORT_COLUMNS: Record<string, string> = {
  age: 'bridge_messages.src_ts',
  amount: 'bridge_messages.amount',
  fee: 'bridge_messages.relayer_fee',
  msg_id: 'bridge_messages.msg_id',
  bridge: 'bridge_messages.bridge',
  status: 'bridge_messages.status',
  direction: 'bridge_messages.direction',
};

export async function listBridgeMessages(opts: {
  bridge?: string | undefined;
  direction?: string | undefined;
  status?: string | undefined;
  sort?: string | undefined;
  dir?: string | undefined;
  limit: number;
  offset: number;
}): Promise<{ rows: BridgeMessageRow[]; total: number }> {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (opts.bridge) { params.push(opts.bridge); where.push(`bridge = $${params.length}`); }
  if (opts.direction) { params.push(opts.direction); where.push(`direction = $${params.length}`); }
  if (opts.status) { params.push(opts.status); where.push(`status = $${params.length}`); }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const totalRes = await q<{ n: string }>(
    `SELECT count(*)::text AS n FROM bridge_messages ${clause}`,
    params,
  );

  const sortCol = SORT_COLUMNS[opts.sort ?? 'age'] ?? 'bridge_messages.src_ts';
  const sortDir = opts.dir === 'asc' ? 'ASC' : 'DESC';
  // NULLS LAST in both directions: rows missing the sort key are never the
  // interesting ones, and a screenful of nulls at the top is just noise.
  const orderBy = `${sortCol} ${sortDir} NULLS LAST, bridge_messages.msg_id ${sortDir}`;

  params.push(opts.limit, opts.offset);
  const rows = await q<{
    bridge: string; direction: string; msg_id: string; status: string;
    amount: string | null; relayer_fee: string | null; receiver: string | null;
    src_height: string | null; src_block: string | null; src_ts: string | null;
    src_tx: string | null; settle_tx: string | null; settle_block: string | null;
    settle_ts: string | null;
  }>(
    `SELECT bridge, direction, msg_id::text, status, amount::text, relayer_fee::text,
            receiver, src_height::text, src_block::text, src_ts::text, src_tx,
            settle_tx, settle_block::text, settle_ts::text
       FROM bridge_messages ${clause}
      ORDER BY ${orderBy}
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  const decOf = new Map(BRIDGES.map((b) => [b.key, b]));

  return {
    total: Number(totalRes.rows[0]?.n ?? 0),
    rows: rows.rows.map((r) => {
      const def = decOf.get(r.bridge);
      // Amounts are denominated on the side the message was observed: outgoing
      // messages carry Beam-side units, incoming ones Ethereum-side units.
      const dec = r.direction === 'beam2eth'
        ? def?.decimals ?? 8
        : def?.ethDecimals ?? 8;
      return {
        bridge: r.bridge,
        direction: r.direction,
        msg_id: Number(r.msg_id),
        status: r.status,
        amount: scale(r.amount, dec),
        relayer_fee: scale(r.relayer_fee, dec),
        receiver: r.receiver,
        src_height: r.src_height === null ? null : Number(r.src_height),
        src_block: r.src_block === null ? null : Number(r.src_block),
        src_ts: r.src_ts,
        src_tx: r.src_tx,
        settle_tx: r.settle_tx,
        settle_block: r.settle_block === null ? null : Number(r.settle_block),
        settle_ts: r.settle_ts,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Transfer lookup: "I sent something across, where is it?"
//
// Accepts either side's identifier. An EVM tx hash matches directly against the
// stored provenance; a Beam kernel id has to be resolved to a height first (we
// don't store kernel ids — the Pipe shader reports only a height per message),
// then matched against outgoing messages at that height.
// ---------------------------------------------------------------------------

export type LookupKind = 'evm_tx' | 'beam_kernel' | 'unrecognised';

export interface BridgeLookupMatch extends BridgeMessageRow {
  label: string;
  /** Which end of the transfer this identifier refers to. */
  role: 'origin' | 'settlement';
  /** Plain-language reading of the current state. */
  explanation: string;
}

export interface BridgeLookupResult {
  query: string;
  kind: LookupKind;
  resolved_height: number | null;
  matches: BridgeLookupMatch[];
}

// Values at or near 2^256 aren't transfers, they're junk pushed into the Pipe.
// Scaled by the asset's decimals they still land astronomically high, so one
// threshold catches them regardless of which side they came from.
const ABSURD = 1e20;

function explain(
  status: string,
  direction: string,
  ageDays: number | null,
  amount: number | null,
  fee: number | null,
): string {
  const malformed = (amount !== null && amount > ABSURD) || (fee !== null && fee > ABSURD);
  if (malformed && status === 'not_delivered') {
    return 'This message carries a nonsensical value (around 2^256, the maximum a uint256 can '
      + 'hold) rather than a real amount. It is junk pushed into the bridge contract, not a '
      + 'transfer, and the relayer will not process it.';
  }
  if (direction === 'eth2beam') {
    switch (status) {
      case 'complete':
        return 'Delivered to Beam and claimed. Nothing outstanding.';
      case 'unclaimed':
        return 'Delivered to Beam and waiting for you to claim it. Open the bridge DApp in your '
          + 'BEAM wallet and receive the funds — only your wallet can sign for them, so this will '
          + 'wait indefinitely until you do.';
      case 'not_delivered':
        if (fee !== null && amount !== null && fee > 0 && amount > 0 && fee / amount < 0.0001) {
          return 'The relayer has not delivered this to Beam. Its relayer fee is very small '
            + 'relative to the amount — likely too small to cover the Ethereum gas the delivery '
            + 'costs — so it may stay here until fees fall far enough to make it worthwhile.';
        }
        return 'The relayer has not delivered this to Beam yet. Relaying costs Ethereum gas, so '
          + 'when the network is expensive the relayer waits for fees to come down before '
          + 'submitting. Nothing is lost while it waits.';
      default:
        return 'Seen on Ethereum, but its state on Beam could not be read just now.';
    }
  }
  switch (status) {
    case 'relayed':
      return 'Settled on Ethereum. Nothing outstanding.';
    case 'failed':
      return 'The settling Ethereum transaction reverted. The relayer normally retries; if this '
        + 'persists, the message needs manual attention.';
    case 'pending':
      return ageDays !== null && ageDays > 1
        ? 'Created on Beam and not yet settled on Ethereum. The relayer batches these and waits '
          + 'for gas to come down, so a delay of hours or days during expensive periods is normal.'
        : 'Created on Beam, waiting for the relayer to settle it on Ethereum.';
    default:
      return 'Created on Beam; its Ethereum settlement could not be read just now.';
  }
}

function toMatch(r: BridgeMessageRow, role: 'origin' | 'settlement'): BridgeLookupMatch {
  const label = BRIDGES.find((b) => b.key === r.bridge)?.label ?? r.bridge;
  const ageDays = r.src_ts ? (Date.now() - Date.parse(r.src_ts)) / 86_400_000 : null;
  return {
    ...r,
    label,
    role,
    explanation: explain(r.status, r.direction, ageDays, r.amount, r.relayer_fee),
  };
}

async function rowsWhere(clause: string, params: Array<string | number>): Promise<BridgeMessageRow[]> {
  const { rows } = await q<{
    bridge: string; direction: string; msg_id: string; status: string;
    amount: string | null; relayer_fee: string | null; receiver: string | null;
    src_height: string | null; src_block: string | null; src_ts: string | null;
    src_tx: string | null; settle_tx: string | null; settle_block: string | null;
    settle_ts: string | null;
  }>(
    `SELECT bridge, direction, msg_id::text, status, amount::text, relayer_fee::text,
            receiver, src_height::text, src_block::text, src_ts::text, src_tx,
            settle_tx, settle_block::text, settle_ts::text
       FROM bridge_messages
      WHERE ${clause}
      ORDER BY bridge_messages.src_ts DESC NULLS LAST
      LIMIT 25`,
    params,
  );
  const defs = new Map(BRIDGES.map((b) => [b.key, b]));
  return rows.map((r) => {
    const def = defs.get(r.bridge);
    const dec = r.direction === 'beam2eth' ? def?.decimals ?? 8 : def?.ethDecimals ?? 8;
    return {
      bridge: r.bridge,
      direction: r.direction,
      msg_id: Number(r.msg_id),
      status: r.status,
      amount: scale(r.amount, dec),
      relayer_fee: scale(r.relayer_fee, dec),
      receiver: r.receiver,
      src_height: r.src_height === null ? null : Number(r.src_height),
      src_block: r.src_block === null ? null : Number(r.src_block),
      src_ts: r.src_ts,
      src_tx: r.src_tx,
      settle_tx: r.settle_tx,
      settle_block: r.settle_block === null ? null : Number(r.settle_block),
      settle_ts: r.settle_ts,
    };
  });
}

export async function lookupBridgeTransfer(raw: string): Promise<BridgeLookupResult> {
  const trimmed = raw.trim();
  const bare = trimmed.replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(bare)) {
    return { query: trimmed, kind: 'unrecognised', resolved_height: null, matches: [] };
  }
  const prefixed = `0x${bare}`;

  // An EVM tx hash and a Beam kernel id are both 32 bytes, so the input alone
  // can't tell them apart. Try the EVM side first (a direct index hit) and only
  // resolve a kernel if nothing matches.
  const evm = await rowsWhere(
    'lower(src_tx) = $1 OR lower(settle_tx) = $1',
    [prefixed],
  );
  if (evm.length > 0) {
    return {
      query: trimmed,
      kind: 'evm_tx',
      resolved_height: null,
      matches: evm.map((r) => toMatch(
        r,
        r.settle_tx?.toLowerCase() === prefixed ? 'settlement' : 'origin',
      )),
    };
  }

  // Beam side. The Pipe shader reports only a height per outgoing message — no
  // kernel id — so the kernel has to be resolved to its block first and matched
  // on height. A height can hold several messages; all of them are returned
  // rather than guessing which one the user meant.
  let height: number | null = null;
  try {
    const block = await getBlock({ kernel: bare });
    height = typeof block.height === 'number' ? block.height : null;
  } catch {
    height = null;
  }
  if (height === null) {
    return { query: trimmed, kind: 'unrecognised', resolved_height: null, matches: [] };
  }

  const beam = await rowsWhere(
    "direction = 'beam2eth' AND src_height = $1",
    [height],
  );
  return {
    query: trimmed,
    kind: 'beam_kernel',
    resolved_height: height,
    matches: beam.map((r) => toMatch(r, 'origin')),
  };
}
