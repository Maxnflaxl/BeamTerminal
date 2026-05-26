import { config } from '../config.js';
import { getContract } from '../explorer.js';
import { parseCallsHistory, type AmmCall } from '../parsers/amm.js';
import { ensureAssetExists } from './assets.js';
import { resolvePoolId } from './pools.js';
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
 * (calls.length >= MAX_CALLS_PER_PAGE) and recursively split the range in half
 * until each sub-window fits — `ON CONFLICT DO NOTHING` on the inserts makes
 * re-covering a boundary cheap.
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
  const calls = parseCallsHistory(resp);

  // Cap-hit on a >1-block window means data was truncated — split and recurse.
  // A single block hitting the cap is exceptional (no realistic AMM has 2000
  // calls in one block); log and process what we got.
  if (calls.length >= MAX_CALLS_PER_PAGE && hMax > hMin) {
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

  for (const call of calls) {
    const blockTs = tsMap.get(call.height);
    if (!blockTs) {
      logger.warn({ height: call.height }, 'no block_ts for call; skipping');
      skipped++;
      continue;
    }

    const written = await writeCall(call, blockTs);
    if (written === 'trade') trades++;
    else if (written === 'lp') lp++;
    else if (written === 'lifecycle') lifecycle++;
    else skipped++;
  }

  if (calls.length >= MAX_CALLS_PER_PAGE && hMin === hMax) {
    logger.warn(
      { height: hMin, calls: calls.length, limit: MAX_CALLS_PER_PAGE },
      'single block exceeded nMaxTxs cap — data beyond limit silently lost',
    );
  }

  return { trades, lp, lifecycle, skipped };
}

type WriteOutcome = 'trade' | 'lp' | 'lifecycle' | 'skipped';

async function writeCall(call: AmmCall, blockTs: Date): Promise<WriteOutcome> {
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
      const poolId = await resolvePoolId({
        aid1: call.aid1,
        aid2: call.aid2,
        kind: call.kind,
      });
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

      await q(
        `INSERT INTO trades (
           pool_id, height, block_ts, aid_in, aid_out,
           amount_in, amount_out, fee_groth,
           volume_aid1, volume_aid2, price_native,
           confirmed
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, FALSE)
         ON CONFLICT (pool_id, height, aid_in, aid_out, amount_in, amount_out, block_ts)
         DO UPDATE SET fee_groth = EXCLUDED.fee_groth
                 WHERE trades.fee_groth IS NULL`,
        [
          poolId,
          call.height,
          blockTs,
          call.aid_in,
          call.aid_out,
          call.amount_in.toString(),
          call.amount_out.toString(),
          call.fee_groth !== null ? call.fee_groth.toString() : null,
          volumeAid1.toString(),
          volumeAid2.toString(),
          priceNative,
        ],
      );
      return 'trade';
    }

    case 'Liquidity Add':
    case 'Liquidity Withdraw': {
      const poolId = await resolvePoolId({
        aid1: call.aid1,
        aid2: call.aid2,
        kind: call.kind,
      });
      if (poolId === null) {
        logger.warn(
          { aid1: call.aid1, aid2: call.aid2, kind: call.kind, height: call.height },
          'LP event on unknown pool — skipping',
        );
        return 'skipped';
      }
      await ensureAssetExists(call.aid_ctl, call.height);

      const kind = call.method === 'Liquidity Add' ? 'Deposit' : 'Withdraw';
      await q(
        `INSERT INTO lp_events (
           pool_id, height, block_ts, kind, amount1, amount2, amount_ctl, confirmed
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE)
         ON CONFLICT (pool_id, height, kind, amount1, amount2, amount_ctl, block_ts)
         DO NOTHING`,
        [
          poolId,
          call.height,
          blockTs,
          kind,
          call.amount1.toString(),
          call.amount2.toString(),
          call.amount_ctl.toString(),
        ],
      );
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
