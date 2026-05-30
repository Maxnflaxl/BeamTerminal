import { q } from '../../db.js';

/**
 * Last-7d price sparkline per pool on a fixed 4h grid (43 points, oldest →
 * newest; the right edge is the current 4h bucket, i.e. "now").
 *
 * Built by carrying each pool's most recent candle close forward across every
 * grid step (last-observation-carried-forward). `candles_4h` only holds a row
 * for a 4h window in which a trade actually happened, so a raw pull leaves an
 * illiquid pair with a handful of points bunched onto an evenly-spaced x-axis —
 * both the shape and the right edge are wrong (the last trade gets drawn at
 * "now" no matter how stale it is). Carrying forward instead yields a
 * continuous, time-accurate line whose last point is the price as of now and
 * whose first point is the price as of 7d ago.
 *
 * Leading steps before a pool's first-ever trade have no close to carry; they
 * are back-filled with that first price so the array is gap-free and the
 * renderer's uniform point spacing stays time-accurate. Pools that have never
 * traded are omitted entirely (callers treat a missing entry as "no data").
 *
 * Values are native price (aid2 per aid1) from candle closes.
 */
export async function loadSparklines7d(
  poolIds: ReadonlyArray<number>,
): Promise<Map<number, number[]>> {
  const out = new Map<number, number[]>();
  if (poolIds.length === 0) return out;

  // For every (pool, 4h grid step) cell, take the most recent candle close at
  // or before that step. The LATERAL both carries the last trade forward across
  // empty windows and seeds the line from the pool's price as of 7d ago when one
  // exists. Cells come back ordered by pool then time, so per-pool grouping
  // below preserves chronological order.
  const { rows } = await q<{ pool_id: string; close: string | null }>(
    `WITH grid AS (
       SELECT generate_series(
         time_bucket('4 hours', now()) - INTERVAL '7 days',
         time_bucket('4 hours', now()),
         INTERVAL '4 hours'
       ) AS b
     ),
     cells AS (
       SELECT pid AS pool_id, g.b
         FROM unnest($1::bigint[]) AS pid
         CROSS JOIN grid g
     )
     SELECT c.pool_id::text AS pool_id,
            snap.close::text AS close
       FROM cells c
       LEFT JOIN LATERAL (
         SELECT cd.close
           FROM candles_4h cd
          WHERE cd.pool_id = c.pool_id AND cd.bucket <= c.b
          ORDER BY cd.bucket DESC
          LIMIT 1
       ) snap ON TRUE
      ORDER BY c.pool_id, c.b ASC`,
    [poolIds as ReadonlyArray<number>],
  );

  // Group ordered cells into per-pool series. NULLs only ever occur as a leading
  // run (steps before a pool's first trade); back-fill them with the first real
  // value so the series is gap-free.
  const seriesByPool = new Map<number, Array<number | null>>();
  for (const r of rows) {
    const id = Number(r.pool_id);
    let v: number | null = r.close === null ? null : Number(r.close);
    if (v !== null && !Number.isFinite(v)) v = null;
    const arr = seriesByPool.get(id);
    if (arr) arr.push(v);
    else seriesByPool.set(id, [v]);
  }

  for (const [id, series] of seriesByPool) {
    const firstReal = series.find((v) => v !== null) ?? null;
    if (firstReal === null) continue; // never traded → omit
    out.set(id, series.map((v) => (v === null ? firstReal : v)));
  }
  return out;
}
