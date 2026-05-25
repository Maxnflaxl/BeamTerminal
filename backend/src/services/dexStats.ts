import { q } from '../db.js';
import { logger } from '../logger.js';

// All-time cumulative trade volume, point-in-time valued. Trades are bucketed
// hourly; each bucket is priced with the *nearest* oracle snapshot and
// BEAM-quoted pool reserves (prefer at-or-before the bucket; fall back to
// earliest-after when the trade pre-dates available history).
//
// Mirrors the CTE that used to live in /api/stats — moved here because the
// query takes long enough on production-size data to exceed CF Tunnel's
// ~100s edge timeout. Recomputing on an indexer-driven cadence keeps the
// API response instant.
const TOTAL_VOLUME_SQL = `
  WITH trade_hourly AS (
    SELECT t.pool_id,
           time_bucket(INTERVAL '1 hour', t.block_ts) AS bucket,
           SUM(t.volume_aid1)::numeric AS vol1,
           SUM(t.volume_aid2)::numeric AS vol2
      FROM trades t
     WHERE t.confirmed = TRUE
     GROUP BY t.pool_id, time_bucket(INTERVAL '1 hour', t.block_ts)
  )
  SELECT COALESCE(SUM(usd_value), 0)::text AS total_volume_usd,
         BOOL_OR(usd_value IS NOT NULL) AS has_any
    FROM (
      SELECT
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
        SELECT beam_reserve, other_reserve FROM (
          (SELECT s.reserve1::numeric AS beam_reserve,
                  s.reserve2::numeric AS other_reserve,
                  0 AS pref
             FROM pools bp
             JOIN pool_state_snapshots s ON s.pool_id = bp.pool_id
            WHERE bp.aid1 = 0 AND bp.aid2 = p.aid1
              AND s.ts <= th.bucket + INTERVAL '1 hour'
              AND s.reserve1 > 0 AND s.reserve2 > 0
            ORDER BY s.ts DESC LIMIT 1)
          UNION ALL
          (SELECT s.reserve1::numeric AS beam_reserve,
                  s.reserve2::numeric AS other_reserve,
                  1 AS pref
             FROM pools bp
             JOIN pool_state_snapshots s ON s.pool_id = bp.pool_id
            WHERE bp.aid1 = 0 AND bp.aid2 = p.aid1
              AND s.ts > th.bucket + INTERVAL '1 hour'
              AND s.reserve1 > 0 AND s.reserve2 > 0
            ORDER BY s.ts ASC LIMIT 1)
        ) ranked
        ORDER BY pref LIMIT 1
      ) bphr1 ON p.aid1 <> 0
      LEFT JOIN LATERAL (
        SELECT beam_reserve, other_reserve FROM (
          (SELECT s.reserve1::numeric AS beam_reserve,
                  s.reserve2::numeric AS other_reserve,
                  0 AS pref
             FROM pools bp
             JOIN pool_state_snapshots s ON s.pool_id = bp.pool_id
            WHERE bp.aid1 = 0 AND bp.aid2 = p.aid2
              AND s.ts <= th.bucket + INTERVAL '1 hour'
              AND s.reserve1 > 0 AND s.reserve2 > 0
            ORDER BY s.ts DESC LIMIT 1)
          UNION ALL
          (SELECT s.reserve1::numeric AS beam_reserve,
                  s.reserve2::numeric AS other_reserve,
                  1 AS pref
             FROM pools bp
             JOIN pool_state_snapshots s ON s.pool_id = bp.pool_id
            WHERE bp.aid1 = 0 AND bp.aid2 = p.aid2
              AND s.ts > th.bucket + INTERVAL '1 hour'
              AND s.reserve1 > 0 AND s.reserve2 > 0
            ORDER BY s.ts ASC LIMIT 1)
        ) ranked
        ORDER BY pref LIMIT 1
      ) bphr2 ON p.aid1 <> 0
    ) sub
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
