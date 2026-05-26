import type { FastifyInstance } from 'fastify';
import { q } from '../../db.js';

interface SeriesPoint {
  ts: number;
  value: number;
}

// ---------------------------------------------------------------------------
// Hashrate per day in Sol/s. Matches the Health page's diffToHashrate logic
// (= difficulty / block_time), aggregated as Σ difficulty / Δt across each
// day's blocks. Chainwork can't be used directly because Beam's chainwork is
// exponential (2^diff per block), not Σ difficulty.
// ---------------------------------------------------------------------------
const HASHRATE_SQL = `
  SELECT EXTRACT(epoch FROM time_bucket(INTERVAL '1 day', block_ts))::bigint AS ts,
         (SUM(difficulty)::float8
            / NULLIF(EXTRACT(epoch FROM MAX(block_ts) - MIN(block_ts)), 0))::float8 AS value
    FROM block_metrics
   WHERE difficulty > 0
   GROUP BY time_bucket(INTERVAL '1 day', block_ts)
  HAVING COUNT(*) > 1
   ORDER BY 1
`;

// Kernels per day = sum of per-block kernel counts in the day's blocks.
const KERNELS_SQL = `
  SELECT EXTRACT(epoch FROM time_bucket(INTERVAL '1 day', block_ts))::bigint AS ts,
         SUM(kernels)::float8 AS value
    FROM block_metrics
   GROUP BY time_bucket(INTERVAL '1 day', block_ts)
   ORDER BY 1
`;

// Cumulative count of registered confidential assets, per day.
// Joins block_metrics (canonical height→ts after backfill) with
// block_timestamps (sparse but populated by the live indexer for
// DEX-touched heights) so we still produce timestamps for assets
// whose lock_height pre-dates the block_metrics backfill.
const ASSETS_SQL = `
  WITH asset_days AS (
    SELECT a.aid,
           time_bucket(INTERVAL '1 day', COALESCE(bm.block_ts, bt.ts)) AS day
      FROM assets a
      LEFT JOIN block_metrics    bm ON bm.height = a.lock_height
      LEFT JOIN block_timestamps bt ON bt.height = a.lock_height
     WHERE a.aid > 0 AND a.lock_height IS NOT NULL
  ),
  per_day AS (
    SELECT day, COUNT(*) AS new_assets
      FROM asset_days
     WHERE day IS NOT NULL
     GROUP BY day
  )
  SELECT EXTRACT(epoch FROM day)::bigint AS ts,
         SUM(new_assets) OVER (ORDER BY day)::float8 AS value
    FROM per_day
   ORDER BY day
`;

// Per-day DEX volume in USD. Mirrors the valuation logic in services/dexStats.ts
// but groups by day instead of summing into a scalar. Each trade hour is priced
// with the nearest oracle snapshot + a BEAM-quoted pool reserve, then those
// hours are bucketed to days.
const DEX_VOLUME_SQL = `
  WITH trade_hourly AS (
    SELECT t.pool_id,
           time_bucket(INTERVAL '1 hour', t.block_ts) AS bucket,
           SUM(t.volume_aid1)::numeric AS vol1,
           SUM(t.volume_aid2)::numeric AS vol2
      FROM trades t
     WHERE t.confirmed = TRUE
     GROUP BY t.pool_id, time_bucket(INTERVAL '1 hour', t.block_ts)
  ),
  priced AS (
    SELECT th.bucket,
           CASE
             WHEN p.aid1 = 0 AND ohb.beam_usd IS NOT NULL THEN
               (th.vol1 / 1e8::numeric) * ohb.beam_usd
             WHEN bphr1.beam_reserve IS NOT NULL AND ohb.beam_usd IS NOT NULL THEN
               (th.vol1 / power(10::numeric, a1.decimals))
                * (bphr1.beam_reserve / 1e8::numeric)
                / NULLIF(bphr1.other_reserve / power(10::numeric, a1.decimals), 0)
                * ohb.beam_usd
             WHEN bphr2.beam_reserve IS NOT NULL AND ohb.beam_usd IS NOT NULL THEN
               (th.vol2 / power(10::numeric, a2.decimals))
                * (bphr2.beam_reserve / 1e8::numeric)
                / NULLIF(bphr2.other_reserve / power(10::numeric, a2.decimals), 0)
                * ohb.beam_usd
           END AS usd_value
      FROM trade_hourly th
      JOIN pools  p  ON p.pool_id = th.pool_id
      JOIN assets a1 ON a1.aid = p.aid1
      JOIN assets a2 ON a2.aid = p.aid2
      LEFT JOIN LATERAL (
        SELECT COALESCE(
          (SELECT beam_usd FROM oracle_snapshots os
            WHERE os.ts <= th.bucket + INTERVAL '1 hour'
            ORDER BY os.ts DESC LIMIT 1),
          (SELECT beam_usd FROM oracle_snapshots os
            WHERE os.ts > th.bucket + INTERVAL '1 hour'
            ORDER BY os.ts ASC LIMIT 1)
        ) AS beam_usd
      ) ohb ON TRUE
      LEFT JOIN LATERAL (
        SELECT s.reserve1::numeric AS beam_reserve,
               s.reserve2::numeric AS other_reserve
          FROM pools bp
          JOIN pool_state_snapshots s ON s.pool_id = bp.pool_id
         WHERE bp.aid1 = 0 AND bp.aid2 = p.aid1
           AND s.ts <= th.bucket + INTERVAL '1 hour'
           AND s.reserve1 > 0 AND s.reserve2 > 0
         ORDER BY s.ts DESC LIMIT 1
      ) bphr1 ON p.aid1 <> 0
      LEFT JOIN LATERAL (
        SELECT s.reserve1::numeric AS beam_reserve,
               s.reserve2::numeric AS other_reserve
          FROM pools bp
          JOIN pool_state_snapshots s ON s.pool_id = bp.pool_id
         WHERE bp.aid1 = 0 AND bp.aid2 = p.aid2
           AND s.ts <= th.bucket + INTERVAL '1 hour'
           AND s.reserve1 > 0 AND s.reserve2 > 0
         ORDER BY s.ts DESC LIMIT 1
      ) bphr2 ON p.aid1 <> 0
  )
  SELECT EXTRACT(epoch FROM time_bucket(INTERVAL '1 day', bucket))::bigint AS ts,
         SUM(usd_value)::float8 AS value
    FROM priced
   WHERE usd_value IS NOT NULL
   GROUP BY time_bucket(INTERVAL '1 day', bucket)
   ORDER BY 1
`;

interface Row {
  ts: string | number;
  value: string | number | null;
}

function toSeries(rows: ReadonlyArray<Row>): SeriesPoint[] {
  const out: SeriesPoint[] = [];
  for (const r of rows) {
    if (r.value === null) continue;
    out.push({ ts: Number(r.ts), value: Number(r.value) });
  }
  return out;
}

export async function chartsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/charts/hashrate', async (_req, reply) => {
    const { rows } = await q<Row>(HASHRATE_SQL);
    void reply.header('cache-control', 'public, max-age=600');
    return { series: toSeries(rows) };
  });

  app.get('/charts/kernels', async (_req, reply) => {
    const { rows } = await q<Row>(KERNELS_SQL);
    void reply.header('cache-control', 'public, max-age=600');
    return { series: toSeries(rows) };
  });

  app.get('/charts/assets', async (_req, reply) => {
    const { rows } = await q<Row>(ASSETS_SQL);
    void reply.header('cache-control', 'public, max-age=600');
    return { series: toSeries(rows) };
  });

  app.get('/charts/dex-volume', async (_req, reply) => {
    const { rows } = await q<Row>(DEX_VOLUME_SQL);
    // Per-day USD valuation reuses the heavy pricing CTE; cache for 30 min.
    void reply.header('cache-control', 'public, max-age=1800');
    return { series: toSeries(rows) };
  });
}
