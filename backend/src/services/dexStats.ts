import { q } from '../db.js';
import { logger } from '../logger.js';

// All-time cumulative trade volume, point-in-time valued. Daily-bucketed
// with materialized JOINs — same methodology as /charts/dex-volume, so the
// header total in /api/stats agrees with the cumulative chart on the page.
//
// Per asset and per day, the cross-rate uses the BEAM-paired pool with the
// largest BEAM reserve (less manipulable than "freshest snapshot wins").
const TOTAL_VOLUME_SQL = `
  WITH oracle_day AS (
    SELECT time_bucket(INTERVAL '1 day', ts) AS day,
           last(beam_usd, ts) AS beam_usd
      FROM oracle_snapshots
     GROUP BY day
  ),
  pool_day AS (
    SELECT pool_id,
           time_bucket(INTERVAL '1 day', ts) AS day,
           last(reserve1, ts)::numeric AS reserve1,
           last(reserve2, ts)::numeric AS reserve2
      FROM pool_state_snapshots
     GROUP BY pool_id, time_bucket(INTERVAL '1 day', ts)
  ),
  beam_paired AS (
    SELECT DISTINCT ON (pd.day, p.aid2)
           pd.day,
           p.aid2 AS asset_aid,
           pd.reserve1::numeric AS beam_reserve,
           pd.reserve2::numeric AS asset_reserve
      FROM pool_day pd
      JOIN pools p ON p.pool_id = pd.pool_id
     WHERE p.aid1 = 0 AND pd.reserve1 > 0 AND pd.reserve2 > 0
     ORDER BY pd.day, p.aid2, pd.reserve1 DESC
  ),
  trade_daily AS (
    SELECT t.pool_id,
           time_bucket(INTERVAL '1 day', t.block_ts) AS day,
           SUM(t.volume_aid1)::numeric AS vol1,
           SUM(t.volume_aid2)::numeric AS vol2
      FROM trades t
     WHERE t.confirmed = TRUE
     GROUP BY t.pool_id, time_bucket(INTERVAL '1 day', t.block_ts)
  ),
  priced AS (
    SELECT
      CASE
        WHEN p.aid1 = 0 AND od.beam_usd IS NOT NULL THEN
          (td.vol1 / 1e8::numeric) * od.beam_usd
        WHEN bp1.beam_reserve IS NOT NULL AND od.beam_usd IS NOT NULL THEN
          (td.vol1 / power(10::numeric, a1.decimals))
           * (bp1.beam_reserve / 1e8::numeric)
           / NULLIF(bp1.asset_reserve / power(10::numeric, a1.decimals), 0)
           * od.beam_usd
        WHEN bp2.beam_reserve IS NOT NULL AND od.beam_usd IS NOT NULL THEN
          (td.vol2 / power(10::numeric, a2.decimals))
           * (bp2.beam_reserve / 1e8::numeric)
           / NULLIF(bp2.asset_reserve / power(10::numeric, a2.decimals), 0)
           * od.beam_usd
      END AS usd_value
      FROM trade_daily td
      JOIN pools  p  ON p.pool_id = td.pool_id
      JOIN assets a1 ON a1.aid = p.aid1
      JOIN assets a2 ON a2.aid = p.aid2
      LEFT JOIN oracle_day  od  ON od.day  = td.day
      LEFT JOIN beam_paired bp1 ON bp1.day = td.day AND bp1.asset_aid = p.aid1
      LEFT JOIN beam_paired bp2 ON bp2.day = td.day AND bp2.asset_aid = p.aid2
  )
  SELECT COALESCE(SUM(usd_value), 0)::text AS total_volume_usd,
         BOOL_OR(usd_value IS NOT NULL) AS has_any
    FROM priced
`;

export interface CachedDexStats {
  total_volume_usd: number | null;
  refreshed_at: Date | null;
}

export async function readDexStats(): Promise<CachedDexStats> {
  const { rows } = await q<{ total_volume_usd: string | null; refreshed_at: Date | null }>(
    'SELECT total_volume_usd::text, refreshed_at FROM dex_stats WHERE id = 1',
  );
  const row = rows[0];
  return {
    total_volume_usd: row?.total_volume_usd != null ? Number(row.total_volume_usd) : null,
    refreshed_at: row?.refreshed_at ?? null,
  };
}

export async function refreshDexStats(): Promise<void> {
  const t0 = Date.now();
  const { rows } = await q<{ total_volume_usd: string; has_any: boolean | null }>(TOTAL_VOLUME_SQL);
  const row = rows[0];
  const value = row?.has_any === true ? row.total_volume_usd : null;
  await q(
    `UPDATE dex_stats
        SET total_volume_usd = $1::numeric,
            refreshed_at     = now()
      WHERE id = 1`,
    [value],
  );
  logger.info({ ms: Date.now() - t0, total_volume_usd: value }, 'dex_stats refreshed');
}
