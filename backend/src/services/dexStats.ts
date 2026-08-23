import { q } from '../db.js';
import { logger } from '../logger.js';

// All-time cumulative trade volume, point-in-time valued. Daily-bucketed
// with materialized JOINs — same methodology as /charts/dex-volume, so the
// header total in /api/stats agrees with the cumulative chart on the page.
//
// Per asset and per day, the cross-rate uses the BEAM-paired pool with the
// largest BEAM reserve (less manipulable than "freshest snapshot wins").
//
// Incremental: closed days are immutable (the 80-block confirmation window
// and any realistic reorg both sit well inside the trailing recompute
// window), so each refresh recomputes only days >= max(day) - 1 into
// dex_stats_daily and sums the stored history — instead of re-scanning the
// full trades/pool_state_snapshots/oracle_snapshots hypertables every 5 min.
const RECOMPUTE_DAILY_SQL = `
  INSERT INTO dex_stats_daily (day, volume_usd, trades)
  WITH oracle_day AS (
    SELECT time_bucket(INTERVAL '1 day', ts) AS day,
           last(beam_usd, ts) AS beam_usd
      FROM oracle_snapshots
     WHERE ts >= $1
     GROUP BY day
  ),
  pool_day AS (
    SELECT pool_id,
           time_bucket(INTERVAL '1 day', ts) AS day,
           last(reserve1, ts)::numeric AS reserve1,
           last(reserve2, ts)::numeric AS reserve2
      FROM pool_state_snapshots
     WHERE ts >= $1
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
           SUM(t.volume_aid2)::numeric AS vol2,
           count(*) AS trades
      FROM trades t
     WHERE t.confirmed = TRUE AND t.block_ts >= $1
     GROUP BY t.pool_id, time_bucket(INTERVAL '1 day', t.block_ts)
  ),
  priced AS (
    SELECT
      td.day,
      td.trades,
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
  SELECT day,
         SUM(usd_value) AS volume_usd,
         SUM(trades)    AS trades
    FROM priced
   GROUP BY day
`;

// SUM skips NULLs, so per-day volume_usd is NULL exactly when no trade that
// day was priceable — preserving the original query's has_any semantics.
const TOTALS_SQL = `
  SELECT COALESCE(SUM(volume_usd), 0)::text AS total_volume_usd,
         BOOL_OR(volume_usd IS NOT NULL)    AS has_any,
         COALESCE(SUM(trades), 0)::text     AS total_trades
    FROM dex_stats_daily
`;

// BEAM's all-time high predates this indexer: oracle_snapshots begins
// 2022-08-13, and the highest price it has ever seen is ~$0.29. The real high
// is $4.28 on 2019-01-04, the day after genesis (verified against CoinGecko's
// `beam` — genesis 2019-01-03, hashing "Beam Hash"; note `beam-2` is the Merit
// Circle rebrand that took the ticker and reports an ATH of $0.044).
//
// Reporting the in-database maximum on its own would be a confidently wrong
// answer, so the cached value is the greater of this constant and whatever the
// oracle has recorded — which means a genuine new high supersedes it without a
// code change.
const KNOWN_ATH_USD = 4.28;
const KNOWN_ATH_TS = new Date('2019-01-04T16:00:00.000Z');

// The low needs no equivalent constant. BEAM's all-time low is $0.00616752 on
// 2026-07-03, well inside the indexed window, so the oracle minimum is the real
// figure — the asymmetry is only because the price has fallen over the years,
// putting the high before this indexer existed and the low after.

export interface CachedDexStats {
  total_volume_usd: number | null;
  total_trades: number | null;
  ath_usd: number | null;
  ath_ts: Date | null;
  atl_usd: number | null;
  atl_ts: Date | null;
  refreshed_at: Date | null;
}

export async function readDexStats(): Promise<CachedDexStats> {
  const { rows } = await q<{
    total_volume_usd: string | null;
    total_trades: string | null;
    refreshed_at: Date | null;
    ath_usd: string | null;
    ath_ts: Date | null;
    atl_usd: string | null;
    atl_ts: Date | null;
  }>(
    `SELECT total_volume_usd::text, total_trades::text, ath_usd::text, ath_ts,
            atl_usd::text, atl_ts, refreshed_at
       FROM dex_stats WHERE id = 1`,
  );
  const row = rows[0];
  // The constant is the floor even before the first refresh, so a fresh deploy
  // reports the real high rather than null.
  const cachedAth = row?.ath_usd != null ? Number(row.ath_usd) : null;
  const useKnown = cachedAth === null || cachedAth < KNOWN_ATH_USD;
  return {
    total_volume_usd: row?.total_volume_usd != null ? Number(row.total_volume_usd) : null,
    total_trades: row?.total_trades != null ? Number(row.total_trades) : null,
    ath_usd: useKnown ? KNOWN_ATH_USD : cachedAth,
    ath_ts: useKnown ? KNOWN_ATH_TS : (row?.ath_ts ?? null),
    atl_usd: row?.atl_usd != null ? Number(row.atl_usd) : null,
    atl_ts: row?.atl_ts ?? null,
    refreshed_at: row?.refreshed_at ?? null,
  };
}

export async function refreshDexStats(): Promise<void> {
  const t0 = Date.now();

  // Recompute the trailing window: from one day before the newest stored day
  // (covers confirmations landing after midnight and reorg rewrites), or from
  // epoch on the first run. Delete-then-insert also clears days a reorg
  // emptied entirely.
  const { rows: markRows } = await q<{ from_day: Date | null }>(
    `SELECT (MAX(day) - INTERVAL '1 day') AS from_day FROM dex_stats_daily`,
  );
  const fromDay = markRows[0]?.from_day ?? new Date(0);
  await q('DELETE FROM dex_stats_daily WHERE day >= $1', [fromDay]);
  await q(RECOMPUTE_DAILY_SQL, [fromDay]);

  const { rows } = await q<{ total_volume_usd: string; has_any: boolean | null; total_trades: string }>(
    TOTALS_SQL,
  );
  // Cheap here (once per 5 min) and unaffordable in /api/stats.
  const [{ rows: athRows }, { rows: atlRows }] = await Promise.all([
    q<{ beam_usd: string; ts: Date }>(
      `SELECT beam_usd::text, ts FROM oracle_snapshots
        WHERE beam_usd IS NOT NULL ORDER BY beam_usd DESC LIMIT 1`,
    ),
    q<{ beam_usd: string; ts: Date }>(
      `SELECT beam_usd::text, ts FROM oracle_snapshots
        WHERE beam_usd IS NOT NULL AND beam_usd > 0 ORDER BY beam_usd ASC LIMIT 1`,
    ),
  ]);
  const row = rows[0];
  const value = row?.has_any === true ? row.total_volume_usd : null;
  const totalTrades = row?.total_trades ?? '0';
  const athRow = athRows[0];
  const atlRow = atlRows[0];
  await q(
    `UPDATE dex_stats
        SET total_volume_usd = $1::numeric,
            total_trades     = $2::bigint,
            ath_usd          = $3::numeric,
            ath_ts           = $4,
            atl_usd          = $5::numeric,
            atl_ts           = $6,
            refreshed_at     = now()
      WHERE id = 1`,
    [
      value,
      totalTrades,
      athRow?.beam_usd ?? null,
      athRow?.ts ?? null,
      atlRow?.beam_usd ?? null,
      atlRow?.ts ?? null,
    ],
  );
  logger.info(
    { ms: Date.now() - t0, total_volume_usd: value, total_trades: totalTrades, ath_usd: athRow?.beam_usd ?? null },
    'dex_stats refreshed',
  );
}
