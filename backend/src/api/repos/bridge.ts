import { q } from '../../db.js';
import { getBlock } from '../../explorer.js';
import { BRIDGES } from '../../services/bridge.js';
import {
  scale, classifyAmounts, unwrapUint64, UINT64_SIGN_BIT_SQL, type MalformedReason,
} from '../../bridgeAmounts.js';
import { loadUsdTable } from './usd.js';

// ---------------------------------------------------------------------------
// Read models for /api/bridge/*.
//
// Postgres only — no shader calls and no Etherscan on the request path. The
// indexer owns all of that; these are projections of what it already wrote.
// ---------------------------------------------------------------------------

export interface BridgeHealthRow {
  bridge: string;
  label: string;
  chain_id: number;
  aid: number;
  eth_pipe: string;
  eth_token: string | null;
  /** Ticker of the Beam-side asset (BEAM, bETH, …). Null if the catalog has no
   *  row for it yet — callers should fall back to the numeric aid. */
  asset_symbol: string | null;
  outgoing: {
    pending: number; relayed: number; failed: number; unknown: number;
    /** Amount underflowed: larger than the bridge holds, so it can never settle. */
    unsettleable: number;
    /** A later message on this bridge already settled, so the relayer moved past it. */
    skipped: number;
    total: number;
  };
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
  /**
   * Open Beam -> Ethereum messages asking for more than the bridge holds. The
   * Beam-side relay has no amount check of its own, so this is the only place
   * such a message shows. Null when there is no escrow snapshot to compare
   * against; 0 means checked and clear.
   */
  over_collateral: number | null;
  /** minted / locked. Null when either side is unknown. ~1.0 means fully backed. */
  collateral_ratio: number | null;
  settlement_source: 'etherscan' | 'unavailable';
}

interface StatusAggRow {
  bridge: string; direction: string; status: string; n: string;
  oldest: string | null; newest: string | null;
}

export async function getBridgeHealth(etherscanOn: boolean): Promise<BridgeHealthRow[]> {
  const [agg, escrow, minted, unclaimed, openOut, usd] = await Promise.all([
    q<StatusAggRow>(
      `SELECT bridge_messages.bridge, bridge_messages.direction,
              ${DERIVED_STATUS} AS status, count(*)::text AS n,
              min(src_ts)::text AS oldest, max(src_ts)::text AS newest
         FROM bridge_messages ${RELAYED_HI_JOIN}
        GROUP BY 1, 2, 3`,
    ),
    q<{
      bridge: string; locked: string; decimals: number; observed_at: string;
      minted: string | null; minted_decimals: number | null;
    }>(
      `SELECT bridge, locked::text, decimals, observed_at::text,
              minted::text, minted_decimals
         FROM bridge_escrow`,
    ),
    q<{
      aid: string; emission: string | null; decimals: number;
      short_name: string | null; name: string | null;
    }>(
      `SELECT aid::text, emission::text, decimals, short_name, name FROM assets
        WHERE aid = ANY($1::bigint[])`,
      [BRIDGES.map((b) => b.aid)],
    ),
    q<{ bridge: string; total: string | null }>(
      `SELECT bridge, sum(amount)::text AS total
         FROM bridge_messages
        WHERE direction = 'eth2beam' AND status = 'unclaimed'
        GROUP BY 1`,
    ),
    // Every outgoing message still awaiting settlement. Only a handful are ever
    // open at once, so the comparison against escrow happens in JS rather than
    // pushing each bridge's own threshold into SQL.
    q<{ bridge: string; amount: string | null; relayer_fee: string | null }>(
      `SELECT bridge, amount::text, relayer_fee::text
         FROM bridge_messages
        WHERE direction = 'beam2eth' AND status IN ('pending', 'unknown')
          AND amount IS NOT NULL`,
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
      unsettleable: pick('beam2eth', 'unsettleable'),
      skipped: pick('beam2eth', 'skipped'),
      total: 0,
    };
    outgoing.total = outgoing.pending + outgoing.relayed + outgoing.failed
      + outgoing.unknown + outgoing.unsettleable + outgoing.skipped;

    const incoming = {
      not_delivered: pick('eth2beam', 'not_delivered'),
      unclaimed: pick('eth2beam', 'unclaimed'),
      complete: pick('eth2beam', 'complete'),
      unknown: pick('eth2beam', 'unknown'),
      total: 0,
    };
    incoming.total = incoming.not_delivered + incoming.unclaimed + incoming.complete + incoming.unknown;

    // The derived statuses are terminal too, so they must not drag
    // oldest_open_ts back to the day they were created.
    const settledStatuses = new Set(['complete', 'relayed', 'unsettleable', 'skipped']);
    const openTimes = mine
      .filter((r) => !settledStatuses.has(r.status))
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
    // Compared as the raw figure that would reach processRemoteMessage, not the
    // negative value we report to readers.
    const overCollateral = lockedVal === null ? null : openOut.rows
      .filter((r) => r.bridge === b.key)
      .filter((r) => {
        const amt = scale(r.amount, b.decimals);
        return amt !== null && amt > lockedVal;
      }).length;

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
      asset_symbol: mint?.short_name ?? mint?.name ?? null,
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
      over_collateral: overCollateral,
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
  /** Block that actually contains the Beam call — what to look up in the
   *  explorer. Differs from src_height, which is the tip the contract saw. */
  src_call_height: number | null;
  src_block: number | null;
  src_ts: string | null;
  src_tx: string | null;
  settle_tx: string | null;
  settle_block: number | null;
  settle_ts: string | null;
  /** eth2beam only: Beam block the relayer delivered the message in. Null on
   *  the upgradable2-wrapped Pipes, whose call arguments the explorer hides. */
  delivered_height: number | null;
  delivered_ts: string | null;
  /** eth2beam only: Beam block the recipient claimed it in. */
  claimed_height: number | null;
  claimed_ts: string | null;
  /**
   * Why the stored figures are not a real transfer, or null when they are.
   *   'overflow'  `amount + relayerFee` wrapped past uint256 in the Ethereum
   *               Pipe — an attempt on the bridge, which the relayer rejects.
   *   'underflow' a Beam-side uint64 that wrapped because the relayer fee
   *               exceeded the amount it was subtracted from.
   * For 'underflow' the reported `amount` is the unwrapped signed value, which
   * is the figure that actually explains the message; for 'overflow' there is
   * no meaningful number and the stored one is reported as-is.
   */
  malformed: MalformedReason | null;
}

interface MessageRowRaw {
  bridge: string; direction: string; msg_id: string; status: string;
  amount: string | null; relayer_fee: string | null; receiver: string | null;
  src_height: string | null; src_call_height: string | null;
  src_block: string | null; src_ts: string | null;
  src_tx: string | null; settle_tx: string | null; settle_block: string | null;
  settle_ts: string | null;
  delivered_height: string | null; delivered_ts: string | null;
  claimed_height: string | null; claimed_ts: string | null;
}

// ---------------------------------------------------------------------------
// Derived outgoing status
//
// A Beam -> Ethereum message stays 'pending' until a settlement is observed,
// which reads as "on its way". The relayer gives up after three attempts, so
// for some messages that never becomes true — see the two cases below.
//
// In SQL rather than toRow() so filtering, sorting, counting and display can't
// disagree: derived in TypeScript, `?status=skipped` would return one set and
// the table would show another.
// ---------------------------------------------------------------------------

const RELAYED_HI_JOIN = `
  LEFT JOIN (
    SELECT bridge, max(msg_id) AS relayed_hi
      FROM bridge_messages
     WHERE direction = 'beam2eth' AND status = 'relayed'
     GROUP BY bridge
  ) hi ON hi.bridge = bridge_messages.bridge`;

const DERIVED_STATUS = `
  CASE WHEN bridge_messages.direction = 'beam2eth' AND bridge_messages.status = 'pending'
            AND bridge_messages.amount >= ${UINT64_SIGN_BIT_SQL} THEN 'unsettleable'
       WHEN bridge_messages.direction = 'beam2eth' AND bridge_messages.status = 'pending'
            AND bridge_messages.msg_id < hi.relayed_hi THEN 'skipped'
       ELSE bridge_messages.status
  END`;

// block_metrics covers every height, so the Beam-side blocks get their wall
// time from a join rather than a stored copy that a reorg could strand.
const MESSAGE_COLUMNS = `
  bridge_messages.bridge, bridge_messages.direction, bridge_messages.msg_id::text,
  ${DERIVED_STATUS} AS status, bridge_messages.amount::text, bridge_messages.relayer_fee::text,
  bridge_messages.receiver, bridge_messages.src_height::text,
  bridge_messages.src_call_height::text, bridge_messages.src_block::text,
  bridge_messages.src_ts::text, bridge_messages.src_tx, bridge_messages.settle_tx,
  bridge_messages.settle_block::text, bridge_messages.settle_ts::text,
  bridge_messages.delivered_height::text, bridge_messages.claimed_height::text,
  (SELECT bm.block_ts::text FROM block_metrics bm
    WHERE bm.height = bridge_messages.delivered_height
    ORDER BY bm.block_ts DESC LIMIT 1) AS delivered_ts,
  (SELECT bm.block_ts::text FROM block_metrics bm
    WHERE bm.height = bridge_messages.claimed_height
    ORDER BY bm.block_ts DESC LIMIT 1) AS claimed_ts`;

function toRow(r: MessageRowRaw): BridgeMessageRow {
  const def = BRIDGES.find((b) => b.key === r.bridge);
  // Amounts are denominated on the side the message was observed: outgoing
  // messages carry Beam-side units, incoming ones Ethereum-side units.
  const dec = r.direction === 'beam2eth' ? def?.decimals ?? 8 : def?.ethDecimals ?? 8;
  const num = (v: string | null): number | null => (v === null ? null : Number(v));
  const malformed = classifyAmounts(r.direction, r.amount, r.relayer_fee);
  // An underflowed amount is reported as what it means — a fee that overshot
  // the amount by this much — rather than as the wrapped remainder.
  const amountRaw = malformed === 'underflow' && r.amount !== null
    ? unwrapUint64(r.amount) : r.amount;
  const amount = scale(amountRaw, dec);
  const fee = scale(r.relayer_fee, dec);
  return {
    bridge: r.bridge,
    direction: r.direction,
    msg_id: Number(r.msg_id),
    status: r.status,
    amount,
    relayer_fee: fee,
    receiver: r.receiver,
    src_height: num(r.src_height),
    src_call_height: num(r.src_call_height),
    src_block: num(r.src_block),
    src_ts: r.src_ts,
    src_tx: r.src_tx,
    settle_tx: r.settle_tx,
    settle_block: num(r.settle_block),
    settle_ts: r.settle_ts,
    delivered_height: num(r.delivered_height),
    delivered_ts: r.delivered_ts,
    claimed_height: num(r.claimed_height),
    claimed_ts: r.claimed_ts,
    malformed,
  };
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
  status: DERIVED_STATUS,
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
  if (opts.bridge) { params.push(opts.bridge); where.push(`bridge_messages.bridge = $${params.length}`); }
  if (opts.direction) { params.push(opts.direction); where.push(`bridge_messages.direction = $${params.length}`); }
  if (opts.status) { params.push(opts.status); where.push(`${DERIVED_STATUS} = $${params.length}`); }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const totalRes = await q<{ n: string }>(
    `SELECT count(*)::text AS n FROM bridge_messages ${RELAYED_HI_JOIN} ${clause}`,
    params,
  );

  const sortCol = SORT_COLUMNS[opts.sort ?? 'age'] ?? 'bridge_messages.src_ts';
  const sortDir = opts.dir === 'asc' ? 'ASC' : 'DESC';
  // NULLS LAST in both directions: rows missing the sort key are never the
  // interesting ones, and a screenful of nulls at the top is just noise.
  const orderBy = `${sortCol} ${sortDir} NULLS LAST, bridge_messages.msg_id ${sortDir}`;

  params.push(opts.limit, opts.offset);
  const rows = await q<MessageRowRaw>(
    `SELECT ${MESSAGE_COLUMNS}
       FROM bridge_messages ${RELAYED_HI_JOIN} ${clause}
      ORDER BY ${orderBy}
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  return {
    total: Number(totalRes.rows[0]?.n ?? 0),
    rows: rows.rows.map(toRow),
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

export type LookupKind = 'evm_tx' | 'beam_kernel' | 'beam_height' | 'unrecognised';

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

function explain(
  status: string,
  direction: string,
  ageDays: number | null,
  amount: number | null,
  fee: number | null,
  malformed: MalformedReason | null,
  beam?: { delivered: number | null; claimed: number | null },
): string {
  const blocks = (() => {
    if (!beam) return '';
    if (beam.delivered !== null && beam.claimed !== null) {
      return ` Delivered in Beam block ${beam.delivered}, claimed in ${beam.claimed}.`;
    }
    if (beam.delivered !== null) return ` Delivered in Beam block ${beam.delivered}.`;
    return '';
  })();
  if (malformed === 'underflow') {
    return 'The amount on this message underflowed: the relayer fee was subtracted from a '
      + 'smaller transferred amount and the unsigned result wrapped around past 2^64. The '
      + 'amount shown is what that works out to — how far the fee overshot. Nothing of value '
      + 'crossed, and no relayer will settle it.';
  }
  if (malformed === 'overflow') {
    return 'This is an attempt on the bridge rather than a transfer. The Ethereum Pipe adds the '
      + 'amount and the relayer fee without an overflow check, so a large enough pair wraps the '
      + 'total back down to almost nothing — letting the sender claim an enormous amount while '
      + 'paying a trivial one. The relayer tests for exactly this and will not deliver it.';
  }
  if (direction === 'eth2beam') {
    switch (status) {
      case 'complete':
        return `Delivered to Beam and claimed. Nothing outstanding.${blocks}`;
      case 'unclaimed':
        return 'Delivered to Beam and waiting for you to claim it. Open the bridge DApp in your '
          + 'BEAM wallet and receive the funds — only your wallet can sign for them, so this will '
          + `wait indefinitely until you do.${blocks}`;
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
    case 'unsettleable':
      return 'This cannot be settled. Its amount is larger than everything the bridge holds, so '
        + 'there is nothing to release against it on the Ethereum side, and no relayer will try.';
    case 'skipped':
      return 'The relayer has moved past this one — later messages on this bridge have already '
        + 'settled, so it is not waiting in a queue. The relayer gives up after three attempts, '
        + 'so it will not be picked up again on its own.';
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
    explanation: explain(r.status, r.direction, ageDays, r.amount, r.relayer_fee, r.malformed, {
      delivered: r.delivered_height,
      claimed: r.claimed_height,
    }),
  };
}

async function rowsWhere(clause: string, params: Array<string | number>): Promise<BridgeMessageRow[]> {
  const { rows } = await q<MessageRowRaw>(
    `SELECT ${MESSAGE_COLUMNS}
       FROM bridge_messages ${RELAYED_HI_JOIN}
      WHERE ${clause}
      ORDER BY bridge_messages.src_ts DESC NULLS LAST
      LIMIT 25`,
    params,
  );
  return rows.map(toRow);
}

// Every way a Beam block can belong to a transfer: the call that created an
// outgoing one, or the delivery / claim of an incoming one. Searching all four
// means a height copied from any row of the table finds its transfer.
const BEAM_HEIGHT_CLAUSE = `
  (direction = 'beam2eth' AND (src_call_height = $1 OR src_height = $1))
  OR (direction = 'eth2beam' AND (delivered_height = $1 OR claimed_height = $1))`;

function beamRole(r: BridgeMessageRow, height: number): 'origin' | 'settlement' {
  if (r.direction === 'beam2eth') return 'origin';
  // An incoming transfer originates on Ethereum, so its Beam blocks are the
  // settling end.
  return r.delivered_height === height || r.claimed_height === height
    ? 'settlement' : 'origin';
}

export async function lookupBridgeTransfer(raw: string): Promise<BridgeLookupResult> {
  const trimmed = raw.trim();

  // A bare number is a Beam height — the only reference the transfers table can
  // show for an outgoing message, since the Pipe records no kernel id per
  // message. Accepting it means what's on screen can be pasted straight in.
  if (/^\d{1,9}$/.test(trimmed)) {
    const h = Number(trimmed);
    const byHeight = await rowsWhere(BEAM_HEIGHT_CLAUSE, [h]);
    return {
      query: trimmed,
      kind: 'beam_height',
      resolved_height: h,
      matches: byHeight.map((r) => toMatch(r, beamRole(r, h))),
    };
  }

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

  // Match the resolved call height first — that's the block the kernel is
  // actually in — and fall back to the contract-reported tip.
  const beam = await rowsWhere(BEAM_HEIGHT_CLAUSE, [height]);
  const h = height;
  return {
    query: trimmed,
    kind: 'beam_kernel',
    resolved_height: height,
    matches: beam.map((r) => toMatch(r, beamRole(r, h))),
  };
}
