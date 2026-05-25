import { q } from '../../db.js';

/**
 * Last-7d price sparkline per pool, sampled from `candles_4h` (42 buckets max).
 * Returned values are native price (aid2 per aid1) from candle closes.
 * Missing pools simply have no entry — callers should treat as empty series.
 */
export async function loadSparklines7d(
  poolIds: ReadonlyArray<number>,
): Promise<Map<number, number[]>> {
  const out = new Map<number, number[]>();
  if (poolIds.length === 0) return out;

  const { rows } = await q<{ pool_id: string; close: string }>(
    `SELECT pool_id::text, close::text
       FROM candles_4h
      WHERE pool_id = ANY($1::bigint[])
        AND bucket >= now() - INTERVAL '7 days'
      ORDER BY pool_id, bucket ASC`,
    [poolIds as ReadonlyArray<number>],
  );

  for (const r of rows) {
    const id = Number(r.pool_id);
    const v = Number(r.close);
    if (!Number.isFinite(v)) continue;
    const arr = out.get(id);
    if (arr) arr.push(v);
    else out.set(id, [v]);
  }
  return out;
}
