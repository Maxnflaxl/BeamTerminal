import { config } from '../config.js';
import { getContract, type ContractResponse } from '../explorer.js';
import { parseCallsHistory, type AmmCall } from '../parsers/amm.js';
import { ensureAssetExists } from './assets.js';
import { resolvePoolId, type PoolKey } from './pools.js';
import { getBlockTsMap } from './blockTimestamps.js';
import { q } from '../db.js';
import { logger } from '../logger.js';

const MAX_CALLS_PER_PAGE = 2000;

/**
 * aid2 per 1 aid1, formatted for a NUMERIC(40, 20) column.
 * BigInt math throughout — no float precision loss for any plausible volume.
 * Returns "0.00000000000000000000" when the divisor is zero (shouldn't happen
 * for valid trades; defensive).
 */
function priceAid2PerAid1(volumeAid1: bigint, volumeAid2: bigint): string {
  if (volumeAid1 === 0n) return '0.00000000000000000000';
  const SCALE = 10n ** 20n;
  const scaled = (volumeAid2 * SCALE) / volumeAid1;
  const s = scaled.toString();
  if (s.length <= 20) return '0.' + s.padStart(20, '0');
  return s.slice(0, -20) + '.' + s.slice(-20);
}

/**
 * Fetches AMM contract calls in [hMin, hMax] and writes trades / lp_events.
 * Returns counts for logging.
 *
 * The explorer caps any single `/contract?nMaxTxs=N` response at N rows (and
 * N is bounded server-side; 2000 is the hard ceiling). When a height window
 * has more calls than the cap, the tail is silently dropped. We detect cap-hit
 * on the raw response (see pageTruncated) and recursively split the range in
 * half until each sub-window fits — `ON CONFLICT DO NOTHING` on the inserts
 * makes re-covering a boundary cheap.
 *
 * Caller is responsible for advancing the cursor *after* this completes.
 */
export async function indexCalls(
  hMin: number,
  hMax: number,
): Promise<{ trades: number; lp: number; lifecycle: number; skipped: number }> {
  const resp = await getContract({
    id: config.DEX_CID,
    state: false,
    hMin,
    hMax,
    nMaxTxs: MAX_CALLS_PER_PAGE,
  });
  const truncated = pageTruncated(resp);
  const calls = parseCallsHistory(resp);

  // Cap-hit on a >1-block window means data was truncated — split and recurse.
  // A single block hitting the cap is exceptional (no realistic AMM has 2000
  // calls in one block); log and process what we got.
  if (truncated && hMax > hMin) {
    const mid = Math.floor((hMin + hMax) / 2);
    logger.info(
      { hMin, hMax, calls: calls.length, limit: MAX_CALLS_PER_PAGE, split_at: mid },
      'page hit nMaxTxs cap; splitting range',
    );
    const [a, b] = await Promise.all([
      indexCalls(hMin, mid),
      indexCalls(mid + 1, hMax),
    ]);
    return {
      trades:    a.trades    + b.trades,
      lp:        a.lp        + b.lp,
      lifecycle: a.lifecycle + b.lifecycle,
      skipped:   a.skipped   + b.skipped,
    };
  }

  if (calls.length === 0) {
    return { trades: 0, lp: 0, lifecycle: 0, skipped: 0 };
  }

  // Resolve every distinct block_ts up-front so individual inserts don't
  // each round-trip to the explorer.
  const tsMap = await getBlockTsMap(calls.map((c) => c.height));

  let trades = 0;
  let lp = 0;
  let lifecycle = 0;
  let skipped = 0;

  // Cache pool-id lookups for this run. The pool set is fixed for the duration
  // of an indexCalls call — snapshotPoolStates upserts every on-chain pool
  // before ingest, and the call loop never creates a resolvable pool_id — so
  // the same (aid1,aid2,kind) tuples resolve to the same id (or the same null)
  // throughout, and we can skip the repeated SELECT against `pools`.
  const poolIds: PoolIdCache = new Map();

  // Trade/LP rows are accumulated and flushed as one multi-row INSERT per
  // table — a 2000-call backfill page is 2 round-trips instead of 2000.
  // Lifecycle calls (Pool Create/Destroy) still write inline; they're rare
  // and target `pools`, which the batched inserts don't touch.
  const tradeRows: TradeInsertRow[] = [];
  const lpRows: LpInsertRow[] = [];

  for (const call of calls) {
    const blockTs = tsMap.get(call.height);
    if (!blockTs) {
      logger.warn({ height: call.height }, 'no block_ts for call; skipping');
      skipped++;
      continue;
    }

    const written = await classifyCall(call, blockTs, poolIds, tradeRows, lpRows);
    if (written === 'trade') trades++;
    else if (written === 'lp') lp++;
    else if (written === 'lifecycle') lifecycle++;
    else skipped++;
  }

  await flushTrades(tradeRows);
  await flushLpEvents(lpRows);

  if (truncated && hMin === hMax) {
    logger.warn(
      { height: hMin, calls: calls.length, limit: MAX_CALLS_PER_PAGE },
      'single block exceeded nMaxTxs cap — data beyond limit silently lost',
    );
  }

  return { trades, lp, lifecycle, skipped };
}

/**
 * Whether the explorer cut the "Calls history" page short. Judged on the raw
 * response, not on the parsed AMM calls: parseCallsHistory drops rows it
 * doesn't recognise (nested fee skims, unknown methods), so a full page can
 * parse to well under the cap and hide the truncation. Prefers the explorer's
 * `more` marker on the table when it sends one; otherwise the raw row count
 * (minus the header row) reaching the cap.
 */
function pageTruncated(resp: ContractResponse): boolean {
  const table = resp['Calls history'];
  const more = table?.more ?? (resp as { more?: { hMax?: number } }).more;
  if (more?.hMax != null) return true;
  const rawRows = (table?.value.length ?? 1) - 1;
  return rawRows >= MAX_CALLS_PER_PAGE;
}

type WriteOutcome = 'trade' | 'lp' | 'lifecycle' | 'skipped';

interface TradeInsertRow {
  poolId: string;
  height: number;
  blockTs: Date;
  aidIn: number;
  aidOut: number;
  amountIn: string;
  amountOut: string;
  feeGroth: string | null;
  volumeAid1: string;
  volumeAid2: string;
  priceNative: string;
}

interface LpInsertRow {
  poolId: string;
  height: number;
  blockTs: Date;
  kind: 'Deposit' | 'Withdraw';
  amount1: string;
  amount2: string;
  amountCtl: string;
}

/** One multi-row INSERT for a page's trades. Batch-internal duplicates on the
 *  natural key are merged in JS first (a multi-row upsert may not touch the
 *  same row twice), reproducing the sequential semantics: first row wins, a
 *  later duplicate only contributes its fee when the kept row has none. */
async function flushTrades(rows: TradeInsertRow[]): Promise<void> {
  if (rows.length === 0) return;
  const byKey = new Map<string, TradeInsertRow>();
  for (const r of rows) {
    const key = `${r.poolId}:${r.height}:${r.aidIn}:${r.aidOut}:${r.amountIn}:${r.amountOut}:${r.blockTs.getTime()}`;
    const kept = byKey.get(key);
    if (!kept) byKey.set(key, r);
    else if (kept.feeGroth === null && r.feeGroth !== null) kept.feeGroth = r.feeGroth;
  }
  const v = [...byKey.values()];
  await q(
    `INSERT INTO trades (
       pool_id, height, block_ts, aid_in, aid_out,
       amount_in, amount_out, fee_groth,
       volume_aid1, volume_aid2, price_native,
       confirmed
     )
     SELECT t.pool_id, t.height, t.block_ts, t.aid_in, t.aid_out,
            t.amount_in, t.amount_out, t.fee_groth,
            t.volume_aid1, t.volume_aid2, t.price_native,
            FALSE
       FROM unnest($1::bigint[], $2::bigint[], $3::timestamptz[], $4::bigint[], $5::bigint[],
                   $6::numeric[], $7::numeric[], $8::numeric[],
                   $9::numeric[], $10::numeric[], $11::numeric[])
              AS t(pool_id, height, block_ts, aid_in, aid_out,
                   amount_in, amount_out, fee_groth,
                   volume_aid1, volume_aid2, price_native)
     ON CONFLICT (pool_id, height, aid_in, aid_out, amount_in, amount_out, block_ts)
     DO UPDATE SET fee_groth = EXCLUDED.fee_groth
             WHERE trades.fee_groth IS NULL`,
    [
      v.map((r) => r.poolId),
      v.map((r) => r.height),
      v.map((r) => r.blockTs),
      v.map((r) => r.aidIn),
      v.map((r) => r.aidOut),
      v.map((r) => r.amountIn),
      v.map((r) => r.amountOut),
      v.map((r) => r.feeGroth),
      v.map((r) => r.volumeAid1),
      v.map((r) => r.volumeAid2),
      v.map((r) => r.priceNative),
    ],
  );
}

/** One multi-row INSERT for a page's LP events. DO NOTHING tolerates
 *  batch-internal duplicates, so no JS dedupe is needed. */
async function flushLpEvents(rows: LpInsertRow[]): Promise<void> {
  if (rows.length === 0) return;
  await q(
    `INSERT INTO lp_events (
       pool_id, height, block_ts, kind, amount1, amount2, amount_ctl, confirmed
     )
     SELECT t.pool_id, t.height, t.block_ts, t.kind, t.amount1, t.amount2, t.amount_ctl, FALSE
       FROM unnest($1::bigint[], $2::bigint[], $3::timestamptz[], $4::text[],
                   $5::numeric[], $6::numeric[], $7::numeric[])
              AS t(pool_id, height, block_ts, kind, amount1, amount2, amount_ctl)
     ON CONFLICT (pool_id, height, kind, amount1, amount2, amount_ctl, block_ts)
     DO NOTHING`,
    [
      rows.map((r) => r.poolId),
      rows.map((r) => r.height),
      rows.map((r) => r.blockTs),
      rows.map((r) => r.kind),
      rows.map((r) => r.amount1),
      rows.map((r) => r.amount2),
      rows.map((r) => r.amountCtl),
    ],
  );
}

// Per-run cache of (aid1,aid2,kind) -> pool_id (or null for "no such pool").
// Caching null is safe within one indexCalls run: the resolvable pool set is
// fixed for its duration (see indexCalls), so a tuple that resolves to null
// stays null — a Trade on an unknown pool is skipped now and on the next tick
// the pool snapshot creates it.
type PoolIdCache = Map<string, bigint | null>;

async function resolvePoolIdCached(key: PoolKey, cache: PoolIdCache): Promise<bigint | null> {
  const k = `${key.aid1}-${key.aid2}-${key.kind}`;
  const cached = cache.get(k);
  if (cached !== undefined) return cached;
  const id = await resolvePoolId(key);
  cache.set(k, id);
  return id;
}

async function classifyCall(
  call: AmmCall,
  blockTs: Date,
  poolIds: PoolIdCache,
  tradeRows: TradeInsertRow[],
  lpRows: LpInsertRow[],
): Promise<WriteOutcome> {
  switch (call.method) {
    case 'Pool Create': {
      // We don't get aid_ctl from the call args (it's derived inside the
      // contract), so we can't fully upsert the pool here. But we can
      // record the deploy height for any existing row that matches.
      await ensureAssetExists(call.aid1, call.height);
      await ensureAssetExists(call.aid2, call.height);
      await q(
        `UPDATE pools
            SET created_at_height = LEAST(created_at_height, $1)
          WHERE aid1 = $2 AND aid2 = $3 AND kind = $4`,
        [call.height, call.aid1, call.aid2, call.kind],
      );
      return 'lifecycle';
    }

    case 'Pool Destroy': {
      await ensureAssetExists(call.aid1, call.height);
      await ensureAssetExists(call.aid2, call.height);
      await q(
        `UPDATE pools SET destroyed_at_height = $1
           WHERE aid1 = $2 AND aid2 = $3 AND kind = $4
             AND destroyed_at_height IS NULL`,
        [call.height, call.aid1, call.aid2, call.kind],
      );
      return 'lifecycle';
    }

    case 'Trade': {
      const poolId = await resolvePoolIdCached(
        { aid1: call.aid1, aid2: call.aid2, kind: call.kind },
        poolIds,
      );
      if (poolId === null) {
        logger.warn(
          { aid1: call.aid1, aid2: call.aid2, kind: call.kind, height: call.height },
          'Trade on unknown pool — pool snapshot will create it on next tick; skipping',
        );
        return 'skipped';
      }
      await ensureAssetExists(call.aid_in, call.height);
      await ensureAssetExists(call.aid_out, call.height);

      // Map directional aid_in/aid_out flows to canonical aid1/aid2 volumes.
      // call.aid1/aid2 are already canonical (aid1 < aid2) from the parser.
      const volumeAid1 =
        call.aid_in === call.aid1 ? call.amount_in : call.amount_out;
      const volumeAid2 =
        call.aid_in === call.aid1 ? call.amount_out : call.amount_in;
      const priceNative = priceAid2PerAid1(volumeAid1, volumeAid2);

      tradeRows.push({
        poolId: poolId.toString(),
        height: call.height,
        blockTs,
        aidIn: call.aid_in,
        aidOut: call.aid_out,
        amountIn: call.amount_in.toString(),
        amountOut: call.amount_out.toString(),
        feeGroth: call.fee_groth !== null ? call.fee_groth.toString() : null,
        volumeAid1: volumeAid1.toString(),
        volumeAid2: volumeAid2.toString(),
        priceNative,
      });
      return 'trade';
    }

    case 'Liquidity Add':
    case 'Liquidity Withdraw': {
      const poolId = await resolvePoolIdCached(
        { aid1: call.aid1, aid2: call.aid2, kind: call.kind },
        poolIds,
      );
      if (poolId === null) {
        logger.warn(
          { aid1: call.aid1, aid2: call.aid2, kind: call.kind, height: call.height },
          'LP event on unknown pool — skipping',
        );
        return 'skipped';
      }
      await ensureAssetExists(call.aid_ctl, call.height);

      const kind = call.method === 'Liquidity Add' ? 'Deposit' : 'Withdraw';
      lpRows.push({
        poolId: poolId.toString(),
        height: call.height,
        blockTs,
        kind,
        amount1: call.amount1.toString(),
        amount2: call.amount2.toString(),
        amountCtl: call.amount_ctl.toString(),
      });
      return 'lp';
    }
  }
}

/**
 * Marks trades / lp_events as confirmed once they reach `CONFIRMATIONS` depth.
 */
export async function promoteToConfirmed(headHeight: number): Promise<{ trades: number; lp: number }> {
  const threshold = headHeight - config.CONFIRMATIONS;
  if (threshold <= 0) return { trades: 0, lp: 0 };

  const t = await q(
    `UPDATE trades SET confirmed = TRUE
       WHERE confirmed = FALSE AND height <= $1`,
    [threshold],
  );
  const l = await q(
    `UPDATE lp_events SET confirmed = TRUE
       WHERE confirmed = FALSE AND height <= $1`,
    [threshold],
  );
  return { trades: t.rowCount ?? 0, lp: l.rowCount ?? 0 };
}
