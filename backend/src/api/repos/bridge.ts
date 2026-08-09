import { q } from '../../db.js';
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
    const mintedVal = esc?.minted !== null && esc?.minted !== undefined
      ? scale(esc.minted, esc.minted_decimals ?? b.ethDecimals)
      : mint?.emission
        ? scale(mint.emission, mint.decimals ?? b.decimals)
        : null;

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

export async function listBridgeMessages(opts: {
  bridge?: string | undefined;
  direction?: string | undefined;
  status?: string | undefined;
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
      ORDER BY src_ts DESC NULLS LAST, msg_id DESC
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
