import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { q } from '../../db.js';
import { fetchNetworkSeries, fetchNetworkSeriesHourly, type NetworkSeries, type ChartPoint } from '../../services/networkStats.js';
import { fetchBlackholeSeries } from '../../services/blackhole.js';
import { supplyAtHeight } from '../../services/beamEmission.js';
import { logger } from '../../logger.js';
import {
  serveRange, RANGE_META, bridgeMultiSeries, bridgeSingleSeries, buildSimpleLevelSql, clampRange,
  RangeTooWideError, type Res as RangeRes, type SimpleLevelChart,
} from './chart-range.js';

interface SeriesPoint {
  ts: number;
  value: number;
}

// The cache and routes serve an opaque JSON body keyed by `series`. For most
// charts that's a flat `SeriesPoint[]`; multi-series charts (e.g. blackhole)
// put their own array shape there. The cache treats it as a black box.
interface ChartBody {
  series: unknown;
}

// The four single-aggregate level charts (hashrate, difficulty, block-time,
// price) take their SQL from chart-range's builder so each aggregate expression
// is written once: the whole table for the daily tier, the trailing 35 days for
// the hourly tier. Hashrate and block time keep their HAVING COUNT(*) > 1 guard
// — a one-block bucket has no Δt.
const HOURLY_WINDOW_DAYS = 35;
function levelSql(name: SimpleLevelChart): Pick<ChartDef, 'sql' | 'hourlySql'> {
  return {
    sql: buildSimpleLevelSql(name, '1d', 'all'),
    hourlySql: buildSimpleLevelSql(name, '1h', { recentDays: HOURLY_WINDOW_DAYS }),
  };
}

// End-of-day reserves per pool, shared by every daily DEX query below. Reads
// the liquidity_1h continuous aggregate instead of re-aggregating the raw
// pool_state_snapshots hypertable's full history per refresh: the last hourly
// `last` of a day is the day's last raw sample, so last-per-day over the hourly
// rows equals last-per-day over the snapshots. The view is real-time
// (materialized_only = false), so the not-yet-materialized tail is included.
const POOL_DAY_CTE = `pool_day AS (
    SELECT pool_id,
           time_bucket(INTERVAL '1 day', bucket) AS day,
           last(reserve1, bucket)::numeric AS reserve1,
           last(reserve2, bucket)::numeric AS reserve2
      FROM liquidity_1h
     GROUP BY pool_id, time_bucket(INTERVAL '1 day', bucket)
  )`;

// Per-day DEX TVL in USD. End-of-day reserves per pool, priced via the
// BEAM oracle directly (BEAM-quoted pools) or via the BEAM-paired pool's
// reserve ratio (cross-rate). Doubles the priceable side to estimate full
// pool value (AMMs hold equal value on both sides at equilibrium).
//
// Materializes a per-day cross-rate map (best BEAM-paired pool per asset
// per day) and JOINs against it — avoids the O(N²) LATERAL pattern when
// pool_state_snapshots is large.
const TVL_SQL = `
  WITH oracle_day AS (
    SELECT time_bucket(INTERVAL '1 day', ts) AS day,
           last(beam_usd, ts) AS beam_usd
      FROM oracle_snapshots
     GROUP BY day
  ),
  ${POOL_DAY_CTE},
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
  priced AS (
    SELECT pd.day,
           CASE
             WHEN p.aid1 = 0 AND od.beam_usd IS NOT NULL THEN
               2 * (pd.reserve1 / 1e8::numeric) * od.beam_usd
             WHEN bp1.beam_reserve IS NOT NULL AND od.beam_usd IS NOT NULL THEN
               2 * (pd.reserve1 / power(10::numeric, a1.decimals))
                 * (bp1.beam_reserve / 1e8::numeric)
                 / NULLIF(bp1.asset_reserve / power(10::numeric, a1.decimals), 0)
                 * od.beam_usd
             WHEN bp2.beam_reserve IS NOT NULL AND od.beam_usd IS NOT NULL THEN
               2 * (pd.reserve2 / power(10::numeric, a2.decimals))
                 * (bp2.beam_reserve / 1e8::numeric)
                 / NULLIF(bp2.asset_reserve / power(10::numeric, a2.decimals), 0)
                 * od.beam_usd
           END AS tvl_usd
      FROM pool_day pd
      JOIN pools  p  ON p.pool_id = pd.pool_id
      JOIN assets a1 ON a1.aid = p.aid1
      JOIN assets a2 ON a2.aid = p.aid2
      LEFT JOIN oracle_day  od  ON od.day  = pd.day
      LEFT JOIN beam_paired bp1 ON bp1.day = pd.day AND bp1.asset_aid = p.aid1
      LEFT JOIN beam_paired bp2 ON bp2.day = pd.day AND bp2.asset_aid = p.aid2
     WHERE pd.reserve1 > 0 OR pd.reserve2 > 0
  )
  SELECT EXTRACT(epoch FROM day)::bigint AS ts,
         SUM(tvl_usd)::float8 AS value
    FROM priced
   WHERE tvl_usd IS NOT NULL
   GROUP BY day
   ORDER BY 1
`;

// Hourly DEX TVL in USD over a recent bounded window. Same cross-rate pricing
// as TVL_SQL, bucketed hourly. A level metric, so no spine/rolling — hours
// without a snapshot simply produce no point (pool_state_snapshots is written
// every ~30s, so gaps are rare).
const TVL_HOURLY_SQL = `
  WITH oracle_h AS (
    SELECT time_bucket(INTERVAL '1 hour', ts) AS hour, last(beam_usd, ts) AS beam_usd
      FROM oracle_snapshots
     WHERE ts > now() - INTERVAL '35 days'
     GROUP BY 1
  ),
  pool_h AS (
    SELECT pool_id, time_bucket(INTERVAL '1 hour', ts) AS hour,
           last(reserve1, ts)::numeric AS reserve1,
           last(reserve2, ts)::numeric AS reserve2
      FROM pool_state_snapshots
     WHERE ts > now() - INTERVAL '35 days'
     GROUP BY pool_id, time_bucket(INTERVAL '1 hour', ts)
  ),
  beam_paired AS (
    SELECT DISTINCT ON (ph.hour, p.aid2)
           ph.hour, p.aid2 AS asset_aid,
           ph.reserve1::numeric AS beam_reserve,
           ph.reserve2::numeric AS asset_reserve
      FROM pool_h ph
      JOIN pools p ON p.pool_id = ph.pool_id
     WHERE p.aid1 = 0 AND ph.reserve1 > 0 AND ph.reserve2 > 0
     ORDER BY ph.hour, p.aid2, ph.reserve1 DESC
  ),
  priced AS (
    SELECT ph.hour,
           CASE
             WHEN p.aid1 = 0 AND od.beam_usd IS NOT NULL THEN
               2 * (ph.reserve1 / 1e8::numeric) * od.beam_usd
             WHEN bp1.beam_reserve IS NOT NULL AND od.beam_usd IS NOT NULL THEN
               2 * (ph.reserve1 / power(10::numeric, a1.decimals))
                 * (bp1.beam_reserve / 1e8::numeric)
                 / NULLIF(bp1.asset_reserve / power(10::numeric, a1.decimals), 0)
                 * od.beam_usd
             WHEN bp2.beam_reserve IS NOT NULL AND od.beam_usd IS NOT NULL THEN
               2 * (ph.reserve2 / power(10::numeric, a2.decimals))
                 * (bp2.beam_reserve / 1e8::numeric)
                 / NULLIF(bp2.asset_reserve / power(10::numeric, a2.decimals), 0)
                 * od.beam_usd
           END AS tvl_usd
      FROM pool_h ph
      JOIN pools  p  ON p.pool_id = ph.pool_id
      JOIN assets a1 ON a1.aid = p.aid1
      JOIN assets a2 ON a2.aid = p.aid2
      LEFT JOIN oracle_h    od  ON od.hour  = ph.hour
      LEFT JOIN beam_paired bp1 ON bp1.hour = ph.hour AND bp1.asset_aid = p.aid1
      LEFT JOIN beam_paired bp2 ON bp2.hour = ph.hour AND bp2.asset_aid = p.aid2
     WHERE ph.reserve1 > 0 OR ph.reserve2 > 0
  )
  SELECT EXTRACT(epoch FROM hour)::bigint AS ts,
         SUM(tvl_usd)::float8 AS value
    FROM priced
   WHERE tvl_usd IS NOT NULL
   GROUP BY hour
   ORDER BY 1
`;

// Coinbase transactions per day. BEAM emits exactly one coinbase OUTPUT per
// block, so the coinbase baseline equals the block count per day. Drawn as a
// baseline overlay under "Transactions / day" — the gap between the two is the
// real (non-coinbase) transaction volume. (`fee == 0` is NOT a coinbase marker
// — early BEAM allowed zero-fee transactions, so some blocks carry multiple
// fee-0 kernels.)
const COINBASE_SQL = `
  SELECT EXTRACT(epoch FROM time_bucket(INTERVAL '1 day', block_ts))::bigint AS ts,
         COUNT(*)::float8 AS value
    FROM block_metrics
   GROUP BY time_bucket(INTERVAL '1 day', block_ts)
   ORDER BY 1
`;

// Hourly coinbase — blocks in the trailing 24h, plotted hourly. Fetches 36d so
// every point in the visible 35d window has a complete 24-bucket trailing sum.
const COINBASE_HOURLY_SQL = `
  WITH hourly AS (
    SELECT time_bucket(INTERVAL '1 hour', block_ts) AS hour, COUNT(*)::numeric AS n
      FROM block_metrics
     WHERE block_ts > now() - INTERVAL '36 days'
     GROUP BY 1
  ),
  spine AS (
    SELECT generate_series(
             time_bucket(INTERVAL '1 hour', now() - INTERVAL '36 days'),
             time_bucket(INTERVAL '1 hour', now()),
             INTERVAL '1 hour'
           ) AS hour
  ),
  filled AS (
    SELECT s.hour, COALESCE(h.n, 0) AS n
      FROM spine s LEFT JOIN hourly h ON h.hour = s.hour
  ),
  rolled AS (
    SELECT hour,
           SUM(n)   OVER (ORDER BY hour ROWS BETWEEN 23 PRECEDING AND CURRENT ROW) AS n24,
           COUNT(*) OVER (ORDER BY hour ROWS BETWEEN 23 PRECEDING AND CURRENT ROW) AS w
      FROM filled
  )
  SELECT EXTRACT(epoch FROM hour)::bigint AS ts, n24::float8 AS value
    FROM rolled
   WHERE w = 24
     AND hour > now() - INTERVAL '35 days'
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

// Hourly cumulative confidential-asset count over a recent bounded window.
// Seeds the running sum with the count of assets locked before the window so
// the line starts at its true level instead of near zero.
const ASSETS_HOURLY_SQL = `
  WITH win AS (
    SELECT EXTRACT(epoch FROM now())::bigint - 35 * 86400 AS since_ts
  ),
  resolved AS (
    SELECT a.aid,
           EXTRACT(epoch FROM COALESCE(bm.block_ts, bt.ts))::bigint AS ts
      FROM assets a
      LEFT JOIN block_metrics    bm ON bm.height = a.lock_height
      LEFT JOIN block_timestamps bt ON bt.height = a.lock_height
     WHERE a.aid > 0 AND a.lock_height IS NOT NULL
  ),
  baseline AS (
    SELECT COUNT(*)::numeric AS n
      FROM resolved WHERE ts IS NOT NULL AND ts < (SELECT since_ts FROM win)
  ),
  per_hour AS (
    SELECT time_bucket(INTERVAL '1 hour', to_timestamp(ts)) AS hour, COUNT(*) AS new_assets
      FROM resolved
     WHERE ts IS NOT NULL AND ts >= (SELECT since_ts FROM win)
     GROUP BY 1
  )
  SELECT EXTRACT(epoch FROM hour)::bigint AS ts,
         ((SELECT n FROM baseline) + SUM(new_assets) OVER (ORDER BY hour))::float8 AS value
    FROM per_hour
   ORDER BY hour
`;

// Cumulative count of pools ever created, per day. Mirrors ASSETS_SQL:
// COALESCE(block_metrics, block_timestamps) maps the on-chain create height to a
// day (both tables cover DEX-touched heights). No filtering — every pools row is
// a pool that was created (imposters included; lifecycle count, not a live list).
const POOLS_CREATED_SQL = `
  WITH pool_days AS (
    SELECT p.pool_id,
           time_bucket(INTERVAL '1 day', COALESCE(bm.block_ts, bt.ts)) AS day
      FROM pools p
      LEFT JOIN block_metrics    bm ON bm.height = p.created_at_height
      LEFT JOIN block_timestamps bt ON bt.height = p.created_at_height
  ),
  per_day AS (
    SELECT day, COUNT(*) AS n
      FROM pool_days
     WHERE day IS NOT NULL
     GROUP BY day
  )
  SELECT EXTRACT(epoch FROM day)::bigint AS ts,
         SUM(n) OVER (ORDER BY day)::float8 AS value
    FROM per_day
   ORDER BY day
`;

// Cumulative count of pools destroyed, per day. Same shape as POOLS_CREATED_SQL
// but keyed on destroyed_at_height and filtered to dead pools. The DEX contract
// only allows PoolDestroy after all liquidity is withdrawn, so death is a real,
// exact event (destroyed_at_height is never approximate).
const POOLS_CLOSED_SQL = `
  WITH pool_days AS (
    SELECT p.pool_id,
           time_bucket(INTERVAL '1 day', COALESCE(bm.block_ts, bt.ts)) AS day
      FROM pools p
      LEFT JOIN block_metrics    bm ON bm.height = p.destroyed_at_height
      LEFT JOIN block_timestamps bt ON bt.height = p.destroyed_at_height
     WHERE p.destroyed_at_height IS NOT NULL
  ),
  per_day AS (
    SELECT day, COUNT(*) AS n
      FROM pool_days
     WHERE day IS NOT NULL
     GROUP BY day
  )
  SELECT EXTRACT(epoch FROM day)::bigint AS ts,
         SUM(n) OVER (ORDER BY day)::float8 AS value
    FROM per_day
   ORDER BY day
`;

// Per-day DEX volume in USD. Daily granularity throughout (we don't actually
// need hourly precision for a multi-year chart). Materializes:
//   - per-day BEAM/USD from oracle_snapshots,
//   - per-day BEAM-paired cross-rates (best-liquidity pool per asset),
// then JOINs against trade_daily. Replaces the previous per-row LATERAL
// pattern which was O(N²) on pool_state_snapshots.
//
// Finally projects onto a calendar-day spine (first trading day → today) with
// COALESCE(…, 0): a day with no trades produces no `trade_daily` row, so without
// this the series silently truncated at the last day with a trade and left gaps
// mid-history. Now every quiet day renders as an explicit 0.
const DEX_VOLUME_SQL = `
  WITH oracle_day AS (
    SELECT time_bucket(INTERVAL '1 day', ts) AS day,
           last(beam_usd, ts) AS beam_usd
      FROM oracle_snapshots
     GROUP BY day
  ),
  ${POOL_DAY_CTE},
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
    SELECT td.day,
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
  ),
  daily_usd AS (
    SELECT day, SUM(usd_value)::float8 AS value
      FROM priced
     WHERE usd_value IS NOT NULL
     GROUP BY day
  ),
  -- Calendar-day spine from the first trading day to today, so no-trade days
  -- render as an explicit 0 instead of vanishing.
  spine AS (
    SELECT generate_series(
             (SELECT MIN(day) FROM daily_usd),
             time_bucket(INTERVAL '1 day', now()),
             INTERVAL '1 day'
           ) AS day
  )
  SELECT EXTRACT(epoch FROM s.day)::bigint AS ts,
         COALESCE(d.value, 0)::float8 AS value
    FROM spine s
    LEFT JOIN daily_usd d ON d.day = s.day
   ORDER BY 1
`;

// Hourly DEX volume in USD, expressed as a trailing-24h rolling sum so the
// chart keeps its "/ day" units at hourly granularity. Same cross-rate pricing
// as DEX_VOLUME_SQL. Fetches 36d so every visible point (35d) has a full
// 24-bucket window; quiet hours are zero-filled via the spine.
const DEX_VOLUME_HOURLY_SQL = `
  WITH oracle_h AS (
    SELECT time_bucket(INTERVAL '1 hour', ts) AS hour, last(beam_usd, ts) AS beam_usd
      FROM oracle_snapshots
     WHERE ts > now() - INTERVAL '36 days'
     GROUP BY 1
  ),
  pool_h AS (
    SELECT pool_id, time_bucket(INTERVAL '1 hour', ts) AS hour,
           last(reserve1, ts)::numeric AS reserve1,
           last(reserve2, ts)::numeric AS reserve2
      FROM pool_state_snapshots
     WHERE ts > now() - INTERVAL '36 days'
     GROUP BY pool_id, time_bucket(INTERVAL '1 hour', ts)
  ),
  beam_paired AS (
    SELECT DISTINCT ON (ph.hour, p.aid2)
           ph.hour, p.aid2 AS asset_aid,
           ph.reserve1::numeric AS beam_reserve,
           ph.reserve2::numeric AS asset_reserve
      FROM pool_h ph
      JOIN pools p ON p.pool_id = ph.pool_id
     WHERE p.aid1 = 0 AND ph.reserve1 > 0 AND ph.reserve2 > 0
     ORDER BY ph.hour, p.aid2, ph.reserve1 DESC
  ),
  trade_h AS (
    SELECT t.pool_id, time_bucket(INTERVAL '1 hour', t.block_ts) AS hour,
           SUM(t.volume_aid1)::numeric AS vol1,
           SUM(t.volume_aid2)::numeric AS vol2
      FROM trades t
     WHERE t.confirmed = TRUE
       AND t.block_ts > now() - INTERVAL '36 days'
     GROUP BY t.pool_id, time_bucket(INTERVAL '1 hour', t.block_ts)
  ),
  priced AS (
    SELECT th.hour,
           CASE
             WHEN p.aid1 = 0 AND od.beam_usd IS NOT NULL THEN
               (th.vol1 / 1e8::numeric) * od.beam_usd
             WHEN bp1.beam_reserve IS NOT NULL AND od.beam_usd IS NOT NULL THEN
               (th.vol1 / power(10::numeric, a1.decimals))
                * (bp1.beam_reserve / 1e8::numeric)
                / NULLIF(bp1.asset_reserve / power(10::numeric, a1.decimals), 0)
                * od.beam_usd
             WHEN bp2.beam_reserve IS NOT NULL AND od.beam_usd IS NOT NULL THEN
               (th.vol2 / power(10::numeric, a2.decimals))
                * (bp2.beam_reserve / 1e8::numeric)
                / NULLIF(bp2.asset_reserve / power(10::numeric, a2.decimals), 0)
                * od.beam_usd
           END AS usd_value
      FROM trade_h th
      JOIN pools  p  ON p.pool_id = th.pool_id
      JOIN assets a1 ON a1.aid = p.aid1
      JOIN assets a2 ON a2.aid = p.aid2
      LEFT JOIN oracle_h    od  ON od.hour  = th.hour
      LEFT JOIN beam_paired bp1 ON bp1.hour = th.hour AND bp1.asset_aid = p.aid1
      LEFT JOIN beam_paired bp2 ON bp2.hour = th.hour AND bp2.asset_aid = p.aid2
  ),
  hourly_usd AS (
    SELECT hour, SUM(usd_value)::float8 AS value
      FROM priced WHERE usd_value IS NOT NULL GROUP BY hour
  ),
  spine AS (
    SELECT generate_series(
             time_bucket(INTERVAL '1 hour', now() - INTERVAL '36 days'),
             time_bucket(INTERVAL '1 hour', now()),
             INTERVAL '1 hour'
           ) AS hour
  ),
  filled AS (
    SELECT s.hour, COALESCE(d.value, 0) AS value
      FROM spine s LEFT JOIN hourly_usd d ON d.hour = s.hour
  ),
  rolled AS (
    SELECT hour,
           SUM(value) OVER (ORDER BY hour ROWS BETWEEN 23 PRECEDING AND CURRENT ROW) AS v24,
           COUNT(*)   OVER (ORDER BY hour ROWS BETWEEN 23 PRECEDING AND CURRENT ROW) AS w
      FROM filled
  )
  SELECT EXTRACT(epoch FROM hour)::bigint AS ts, v24::float8 AS value
    FROM rolled
   WHERE w = 24
     AND hour > now() - INTERVAL '35 days'
   ORDER BY 1
`;

// Per-day BEAM volatility index: 30-day rolling, annualized standard deviation
// of daily BEAM/USD log returns, in percent. No options market exists on the
// DEX, so this is *realized* volatility — the faithful analog of a VIX. The
// 30-day window mirrors the VIX's 30-day horizon; we annualize with √365 since
// the DEX trades 24/7 (calendar days, not 252 trading days). A point is emitted
// only once the window holds a full 30 returns, so the line doesn't mislead at
// the series start.
const BEAM_VOL_SQL = `
  WITH daily AS (
    SELECT time_bucket(INTERVAL '1 day', ts) AS day,
           last(beam_usd, ts)::float8 AS close
      FROM oracle_snapshots
     GROUP BY day
  ),
  returns AS (
    SELECT day,
           ln(close / NULLIF(lag(close) OVER (ORDER BY day), 0)) AS r
      FROM daily
     WHERE close > 0
  ),
  rolled AS (
    SELECT day,
           stddev_samp(r) OVER w AS sd,
           count(r)       OVER w AS n
      FROM returns
    WINDOW w AS (ORDER BY day ROWS BETWEEN 29 PRECEDING AND CURRENT ROW)
  )
  SELECT EXTRACT(epoch FROM day)::bigint AS ts,
         (sd * sqrt(365) * 100)::float8 AS value
    FROM rolled
   WHERE n >= 30 AND sd IS NOT NULL
   ORDER BY day
`;

// Daily BEAM/USD closing price from oracle snapshots.
// ---------------------------------------------------------------------------
// Market cap in USD per day: circulating supply x that day's closing BEAM/USD.
//
// Supply has no history anywhere in the system - `assets.emission` for aid 0 is
// a single mutable column, rewritten in place by services/beamSupply.ts from
// the explorer's /status, which takes no height. So it is derived from height,
// which `block_metrics` does have per day, through services/beamEmission.ts.
//
// The multiplication happens in JS rather than in the query because the
// emission schedule is not a smooth curve: the miner reward truncates on an
// integer shift and the treasury arrives in 60 monthly bursts, and the closed
// form that fits both in SQL is measurably wrong in the middle - up to 0.48%
// during treasury vesting, which covers everything before January 2024. See
// beamEmission.ts.
//
// The series starts where `oracle_snapshots` does (Aug 2022), not at genesis:
// there is no price before that to multiply by.
//
// The `bridge-tvl` series is derived the same way, for the same reason:
// `bridge_escrow` is one row per bridge rewritten in place (migration 045 calls
// it "a 'current value' gauge, not a time series"), so its history is
// reconstructed from `bridge_messages` flow plus Pipe Funds deltas, anchored to
// the current snapshot. See services/bridgeTvl.ts.
// ---------------------------------------------------------------------------
interface HeightPriceRow {
  ts: string;
  h: string;
  beam_usd: string;
}

function marketCapSql(bucket: '1 day' | '1 hour', recentOnly: boolean): string {
  const window = recentOnly ? "WHERE ts > now() - INTERVAL '35 days'" : '';
  const blockWindow = recentOnly ? "WHERE block_ts > now() - INTERVAL '35 days'" : '';
  return `
    WITH price_b AS (
      SELECT time_bucket(INTERVAL '${bucket}', ts) AS b,
             last(beam_usd, ts)::float8 AS beam_usd
        FROM oracle_snapshots
       ${window ? `${window} AND beam_usd IS NOT NULL` : 'WHERE beam_usd IS NOT NULL'}
       GROUP BY 1
    ),
    height_b AS (
      SELECT time_bucket(INTERVAL '${bucket}', block_ts) AS b,
             MAX(height)::bigint AS h
        FROM block_metrics
       ${blockWindow}
       GROUP BY 1
    )
    SELECT EXTRACT(epoch FROM p.b)::bigint::text AS ts,
           hb.h::text AS h,
           p.beam_usd::text AS beam_usd
      FROM price_b p
      JOIN height_b hb ON hb.b = p.b
     ORDER BY 1
  `;
}

async function marketCapSeries(bucket: '1 day' | '1 hour', recentOnly: boolean): Promise<SeriesPoint[]> {
  const { rows } = await q<HeightPriceRow>(marketCapSql(bucket, recentOnly));
  return rows.map((r) => ({
    ts: Number(r.ts),
    value: supplyAtHeight(Number(r.h)) * Number(r.beam_usd),
  }));
}

// Per-day DEX-wide volatility index: TVL-weighted average of per-pool realized
// volatility across all pairs, in percent. Per-pool daily closes come from
// candles_1d; each pool's 30-day rolling annualized vol is weighted by that
// pool's end-of-day USD TVL (same cross-rate pricing as TVL_SQL — BEAM oracle
// for BEAM-quoted pools, best BEAM-paired pool's reserve ratio otherwise).
// Dust pools (TVL < $100) and pools without a full 30-return window are
// excluded so thin/new markets don't spike the index.
//
// A no-trade day yields no new close → no return → no recompute, so the raw
// index would dead-end at the last day with a trade. We carry the last value
// forward (LOCF) across those days up to today: a presentation-only fill that
// leaves the computed points untouched. Filling with 0 would be wrong here — a
// quiet day isn't "zero volatility" — and injecting 0-returns would deflate the
// index during the (frequent) quiet stretches.
const DEX_VOL_SQL = `
  WITH oracle_day AS (
    SELECT time_bucket(INTERVAL '1 day', ts) AS day,
           last(beam_usd, ts) AS beam_usd
      FROM oracle_snapshots
     GROUP BY day
  ),
  ${POOL_DAY_CTE},
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
  pool_tvl AS (
    SELECT pd.pool_id,
           pd.day,
           CASE
             WHEN p.aid1 = 0 AND od.beam_usd IS NOT NULL THEN
               2 * (pd.reserve1 / 1e8::numeric) * od.beam_usd
             WHEN bp1.beam_reserve IS NOT NULL AND od.beam_usd IS NOT NULL THEN
               2 * (pd.reserve1 / power(10::numeric, a1.decimals))
                 * (bp1.beam_reserve / 1e8::numeric)
                 / NULLIF(bp1.asset_reserve / power(10::numeric, a1.decimals), 0)
                 * od.beam_usd
             WHEN bp2.beam_reserve IS NOT NULL AND od.beam_usd IS NOT NULL THEN
               2 * (pd.reserve2 / power(10::numeric, a2.decimals))
                 * (bp2.beam_reserve / 1e8::numeric)
                 / NULLIF(bp2.asset_reserve / power(10::numeric, a2.decimals), 0)
                 * od.beam_usd
           END AS tvl_usd
      FROM pool_day pd
      JOIN pools  p  ON p.pool_id = pd.pool_id
      JOIN assets a1 ON a1.aid = p.aid1
      JOIN assets a2 ON a2.aid = p.aid2
      LEFT JOIN oracle_day  od  ON od.day  = pd.day
      LEFT JOIN beam_paired bp1 ON bp1.day = pd.day AND bp1.asset_aid = p.aid1
      LEFT JOIN beam_paired bp2 ON bp2.day = pd.day AND bp2.asset_aid = p.aid2
  ),
  pool_close AS (
    SELECT pool_id,
           time_bucket(INTERVAL '1 day', bucket) AS day,
           last(close, bucket)::float8 AS close
      FROM candles_1d
     GROUP BY pool_id, time_bucket(INTERVAL '1 day', bucket)
  ),
  pool_returns AS (
    SELECT pool_id, day,
           ln(close / NULLIF(lag(close) OVER (PARTITION BY pool_id ORDER BY day), 0)) AS r
      FROM pool_close
     WHERE close > 0
  ),
  pool_vol AS (
    SELECT pool_id, day,
           stddev_samp(r) OVER w * sqrt(365) * 100 AS vol,
           count(r)       OVER w AS n
      FROM pool_returns
    WINDOW w AS (PARTITION BY pool_id ORDER BY day ROWS BETWEEN 29 PRECEDING AND CURRENT ROW)
  ),
  index_daily AS (
    SELECT pv.day,
           (SUM(pv.vol * pt.tvl_usd) / NULLIF(SUM(pt.tvl_usd), 0))::float8 AS value
      FROM pool_vol pv
      JOIN pool_tvl pt ON pt.pool_id = pv.pool_id AND pt.day = pv.day
     WHERE pv.n >= 30 AND pv.vol IS NOT NULL
       AND pt.tvl_usd IS NOT NULL AND pt.tvl_usd >= 100
     GROUP BY pv.day
  ),
  -- Calendar-day spine from the first index day to today.
  spine AS (
    SELECT generate_series(
             (SELECT MIN(day) FROM index_daily),
             time_bucket(INTERVAL '1 day', now()),
             INTERVAL '1 day'
           ) AS day
  ),
  -- LOCF: count() ignores NULLs, so each gap inherits the group id of the last
  -- real point; first_value then carries that point's value forward.
  filled AS (
    SELECT s.day,
           id.value,
           count(id.value) OVER (ORDER BY s.day) AS grp
      FROM spine s
      LEFT JOIN index_daily id ON id.day = s.day
  )
  SELECT EXTRACT(epoch FROM day)::bigint AS ts,
         first_value(value) OVER (PARTITION BY grp ORDER BY day) AS value
    FROM filled
   ORDER BY day
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

// ---------------------------------------------------------------------------
// Server-side cache. The underlying SQL touches the full ~3y of block_metrics
// or pool_state_snapshots — multi-second queries that the frontend fires in
// parallel on page load. We pre-warm at boot and refresh every 30 min in the
// background; routes just return the cached series.
//
// Stale-while-revalidate: once an entry has data, refresh failures keep the
// last-known-good series rather than 500ing.
// ---------------------------------------------------------------------------
interface ChartDef {
  name: string;
  /** SQL run by `runQuery`. Mutually exclusive with `fetch` / `fetchBody`. */
  sql?: string;
  /** Custom fetcher when the data isn't a single Postgres aggregate (e.g.
   *  pulling from the explorer's /hdrs endpoint). Returns a ready series. */
  fetch?: () => Promise<SeriesPoint[]>;
  /** Custom fetcher returning a full response body — for charts whose `series`
   *  isn't a flat `SeriesPoint[]` (e.g. the multi-series blackhole chart). */
  fetchBody?: () => Promise<ChartBody>;
  /** Browser cache hint (the server-side cache is independent). */
  maxAgeSec: number;
  /** Hourly-resolution SQL (bounded recent window). Enables `?res=1h`. */
  hourlySql?: string;
  /** Hourly-resolution custom fetcher (explorer charts). Enables `?res=1h`. */
  hourlyFetch?: () => Promise<SeriesPoint[]>;
  /** How often the background refresher recomputes this chart. Defaults to
   *  `REFRESH_INTERVAL_MS`, which suits a slow historical series where the only
   *  thing a stale entry costs is a late final point. A chart whose last point
   *  is a live headline figure needs to track `maxAgeSec` instead, or the number
   *  it publishes drifts away from the one the range-mode path computes on
   *  demand. */
  refreshMs?: number;
}

// Network-stats group is fetched once and split into ten series; this group
// lives behind a single in-memory promise so we don't hit the explorer eleven
// times per refresh.
let networkSeriesInflight: Promise<NetworkSeries> | null = null;
let networkSeriesAt = 0;
const NETWORK_SERIES_TTL_MS = 30 * 60 * 1000;
async function getNetworkSeries(): Promise<NetworkSeries> {
  const now = Date.now();
  if (now - networkSeriesAt > NETWORK_SERIES_TTL_MS) networkSeriesInflight = null;
  if (!networkSeriesInflight) {
    networkSeriesInflight = fetchNetworkSeries()
      .then((s) => { networkSeriesAt = Date.now(); return s; })
      .catch((err) => { networkSeriesInflight = null; throw err; });
  }
  return networkSeriesInflight;
}
function netFetcher(key: keyof NetworkSeries): () => Promise<SeriesPoint[]> {
  return async () => {
    const s = await getNetworkSeries();
    return s[key] as ChartPoint[];
  };
}

let networkSeriesHourlyInflight: Promise<NetworkSeries> | null = null;
let networkSeriesHourlyAt = 0;
const NETWORK_SERIES_HOURLY_TTL_MS = 10 * 60 * 1000; // recent data: refresh more often
async function getNetworkSeriesHourly(): Promise<NetworkSeries> {
  const now = Date.now();
  if (now - networkSeriesHourlyAt > NETWORK_SERIES_HOURLY_TTL_MS) networkSeriesHourlyInflight = null;
  if (!networkSeriesHourlyInflight) {
    networkSeriesHourlyInflight = fetchNetworkSeriesHourly()
      .then((s) => { networkSeriesHourlyAt = Date.now(); return s; })
      .catch((err) => { networkSeriesHourlyInflight = null; throw err; });
  }
  return networkSeriesHourlyInflight;
}
function netFetcherHourly(key: keyof NetworkSeries): () => Promise<SeriesPoint[]> {
  return async () => {
    const s = await getNetworkSeriesHourly();
    return s[key] as ChartPoint[];
  };
}

const CHART_DEFS: ReadonlyArray<ChartDef> = [
  { name: 'hashrate',   ...levelSql('hashrate'),   maxAgeSec: 600 },
  { name: 'coinbase',   sql: COINBASE_SQL,   hourlySql: COINBASE_HOURLY_SQL,   maxAgeSec: 600 },
  { name: 'assets',     sql: ASSETS_SQL,     hourlySql: ASSETS_HOURLY_SQL,     maxAgeSec: 600 },
  { name: 'dex-volume', sql: DEX_VOLUME_SQL, hourlySql: DEX_VOLUME_HOURLY_SQL, maxAgeSec: 1800 },
  { name: 'difficulty', ...levelSql('difficulty'), maxAgeSec: 600 },
  { name: 'block-time', ...levelSql('block-time'), maxAgeSec: 600 },
  { name: 'tvl',        sql: TVL_SQL,        hourlySql: TVL_HOURLY_SQL,        maxAgeSec: 1800 },
  { name: 'pools-created', sql: POOLS_CREATED_SQL, maxAgeSec: 1800 },
  { name: 'pools-closed',  sql: POOLS_CLOSED_SQL,  maxAgeSec: 1800 },
  { name: 'beam-vol',   sql: BEAM_VOL_SQL,   maxAgeSec: 1800 },
  { name: 'dex-vol',    sql: DEX_VOL_SQL,    maxAgeSec: 1800 },
  { name: 'price',      ...levelSql('price'),      maxAgeSec: 600 },
  { name: 'market-cap', fetch: () => marketCapSeries('1 day', false),
                        hourlyFetch: () => marketCapSeries('1 hour', true), maxAgeSec: 600 },
  // From the explorer's /hdrs endpoint (one fetch yields all ten).
  { name: 'transactions-daily',  fetch: netFetcher('daily_txs'),            hourlyFetch: netFetcherHourly('daily_txs'),            maxAgeSec: 600 },
  { name: 'transactions-total',  fetch: netFetcher('total_txs'),            hourlyFetch: netFetcherHourly('total_txs'),            maxAgeSec: 600 },
  { name: 'txos-total',          fetch: netFetcher('total_mw_outputs'),     hourlyFetch: netFetcherHourly('total_mw_outputs'),     maxAgeSec: 600 },
  { name: 'utxos-total',         fetch: netFetcher('total_utxos'),          hourlyFetch: netFetcherHourly('total_utxos'),          maxAgeSec: 600 },
  { name: 'size-total',          fetch: netFetcher('total_size_bytes'),     hourlyFetch: netFetcherHourly('total_size_bytes'),     maxAgeSec: 600 },
  { name: 'archive-total',       fetch: netFetcher('total_archive_bytes'),  hourlyFetch: netFetcherHourly('total_archive_bytes'),  maxAgeSec: 600 },
  { name: 'shielded-ins-daily',  fetch: netFetcher('daily_sh_inputs'),      hourlyFetch: netFetcherHourly('daily_sh_inputs'),      maxAgeSec: 600 },
  { name: 'shielded-ins-total',  fetch: netFetcher('total_sh_inputs'),      hourlyFetch: netFetcherHourly('total_sh_inputs'),      maxAgeSec: 600 },
  { name: 'shielded-outs-daily', fetch: netFetcher('daily_sh_outputs'),     hourlyFetch: netFetcherHourly('daily_sh_outputs'),     maxAgeSec: 600 },
  { name: 'shielded-outs-total', fetch: netFetcher('total_sh_outputs'),     hourlyFetch: netFetcherHourly('total_sh_outputs'),     maxAgeSec: 600 },
  { name: 'contracts-total',     fetch: netFetcher('total_contracts'),      hourlyFetch: netFetcherHourly('total_contracts'),      maxAgeSec: 600 },
  { name: 'fees-daily',          fetch: netFetcher('daily_fee_groth'),      hourlyFetch: netFetcherHourly('daily_fee_groth'),      maxAgeSec: 600 },
  { name: 'fees-total',          fetch: netFetcher('total_fee_groth'),      hourlyFetch: netFetcherHourly('total_fee_groth'),      maxAgeSec: 600 },
  { name: 'contract-calls-daily',fetch: netFetcher('daily_contract_calls'), hourlyFetch: netFetcherHourly('daily_contract_calls'), maxAgeSec: 600 },
  { name: 'contract-calls-total',fetch: netFetcher('total_contract_calls'), hourlyFetch: netFetcherHourly('total_contract_calls'), maxAgeSec: 600 },
  // Multi-series: one cumulative line per asset locked in the BlackHole contract.
  { name: 'blackhole',           fetchBody: fetchBlackholeSeries,           maxAgeSec: 1800 },
  // Bridge transfer, fee and TVL series — 300s matches the bridge sync cadence.
  // Default-mode fetchers route through the same bridgeSingleSeries/bridgeMultiSeries
  // used by serveRange's range mode so the two paths can't drift apart.
  // bridge-tvl and bridge-tvl-by-asset sit adjacent: both hit the same 60s
  // `loadLockedHistory` TTL in bridgeTvl.ts, so keeping their pre-warms next to
  // each other avoids straddling that window and paying for two reconstructions.
  // The TVL pair refreshes on its own 5-minute cycle rather than the shared
  // 30-minute one: their last point is today's locked value in USD, the same
  // headline /api/bridge/health serves, so a half-hour-old cache publishes a
  // figure that visibly disagrees with the range-mode path and the Bridge page.
  // Cheap, because loadLockedHistory's own 60s TTL absorbs the reconstruction —
  // what an extra cycle actually costs is one more cross-rate pass.
  { name: 'bridge-tvl',                    fetch: () => bridgeSingleSeries('bridge-tvl', '1d'), maxAgeSec: 300, refreshMs: 300_000 },
  { name: 'bridge-tvl-by-asset',           fetchBody: async () => ({ series: await bridgeMultiSeries('bridge-tvl-by-asset', '1d') }), maxAgeSec: 300, refreshMs: 300_000 },
  { name: 'bridge-transfers',              fetch: () => bridgeSingleSeries('bridge-transfers', '1d'), maxAgeSec: 300 },
  { name: 'bridge-transfers-by-direction', fetchBody: async () => ({ series: await bridgeMultiSeries('bridge-transfers-by-direction', '1d') }), maxAgeSec: 300 },
  { name: 'bridge-transfers-by-bridge',    fetchBody: async () => ({ series: await bridgeMultiSeries('bridge-transfers-by-bridge', '1d') }), maxAgeSec: 300 },
  { name: 'bridge-transfers-total',        fetch: () => bridgeSingleSeries('bridge-transfers-total', '1d'), maxAgeSec: 300 },
  { name: 'bridge-fees',                   fetch: () => bridgeSingleSeries('bridge-fees', '1d'), maxAgeSec: 300 },
  { name: 'bridge-fees-total',             fetch: () => bridgeSingleSeries('bridge-fees-total', '1d'), maxAgeSec: 300 },
];

const REFRESH_INTERVAL_MS = 30 * 60 * 1000;

interface CacheEntry {
  body: ChartBody | null;
  /** SHA-1 of the JSON body, used to short-circuit If-None-Match requests
   *  with a 304 once the client has cached this version. */
  etag: string | null;
  refreshedAt: number;
  inflight: Promise<ChartBody> | null;
}

const cache = new Map<string, CacheEntry>();

function computeEtag(body: ChartBody): string {
  return `"${createHash('sha1').update(JSON.stringify(body)).digest('hex')}"`;
}

type Res = '1h' | '1d';
function hasHourly(def: ChartDef): boolean {
  return def.hourlySql !== undefined || def.hourlyFetch !== undefined;
}
function cacheKey(name: string, res: Res): string {
  return `${name}:${res}`;
}

async function runQuery(def: ChartDef, res: Res): Promise<ChartBody> {
  const t0 = Date.now();
  let body: ChartBody;
  if (res === '1h' && def.hourlyFetch) {
    body = { series: await def.hourlyFetch() };
  } else if (res === '1h' && def.hourlySql) {
    const { rows } = await q<Row>(def.hourlySql);
    body = { series: toSeries(rows) };
  } else if (def.fetchBody) {
    body = await def.fetchBody();
  } else if (def.fetch) {
    body = { series: await def.fetch() };
  } else if (def.sql) {
    const { rows } = await q<Row>(def.sql);
    body = { series: toSeries(rows) };
  } else {
    throw new Error(`chart ${def.name} has neither sql nor fetch`);
  }
  const n = Array.isArray(body.series) ? body.series.length : 0;
  logger.debug({ chart: def.name, res, points: n, ms: Date.now() - t0 }, 'chart refreshed');
  return body;
}

async function refresh(def: ChartDef, res: Res): Promise<ChartBody> {
  const key = cacheKey(def.name, res);
  const existing = cache.get(key);
  if (existing?.inflight) return existing.inflight;
  const inflight = runQuery(def, res);
  cache.set(key, {
    body:   existing?.body   ?? null,
    etag:   existing?.etag   ?? null,
    refreshedAt: existing?.refreshedAt ?? 0,
    inflight,
  });
  try {
    const body = await inflight;
    cache.set(key, { body, etag: computeEtag(body), refreshedAt: Date.now(), inflight: null });
    return body;
  } catch (err) {
    cache.set(key, {
      body:   existing?.body   ?? null,
      etag:   existing?.etag   ?? null,
      refreshedAt: existing?.refreshedAt ?? 0,
      inflight: null,
    });
    throw err;
  }
}

async function getBody(def: ChartDef, res: Res): Promise<ChartBody> {
  // A daily-only chart asked for 1h falls back to its daily body.
  const eff: Res = res === '1h' && !hasHourly(def) ? '1d' : res;
  const entry = cache.get(cacheKey(def.name, eff));
  if (entry?.body && !entry.inflight) return entry.body;
  if (entry?.inflight) return entry.body ?? entry.inflight;
  return refresh(def, eff);
}

/** Kick off pre-warm + periodic refresh. Call once on API startup. */
export function startChartCacheRefresher(): void {
  // (def, res) units: every chart's daily tier, plus the hourly tier for
  // intraday-capable charts.
  const units: ReadonlyArray<{ def: ChartDef; res: Res }> = CHART_DEFS.flatMap((def) =>
    hasHourly(def)
      ? [{ def, res: '1d' as Res }, { def, res: '1h' as Res }]
      : [{ def, res: '1d' as Res }],
  );
  // Serial pre-warm — don't slam Postgres with many heavy queries at once.
  void (async () => {
    for (const u of units) {
      await refresh(u.def, u.res).catch((err: unknown) => {
        logger.warn({ chart: u.def.name, res: u.res, err }, 'chart pre-warm failed');
      });
    }
  })();
  // Periodic refresh, each unit on its own offset to spread DB load. The offset
  // is spread over the shared interval even for a unit that then runs faster —
  // it only decides which second in the cycle that unit starts on.
  units.forEach((u, i) => {
    const every = u.def.refreshMs ?? REFRESH_INTERVAL_MS;
    const offset = (REFRESH_INTERVAL_MS / units.length) * i;
    setTimeout(() => {
      setInterval(() => {
        refresh(u.def, u.res).catch((err: unknown) => {
          logger.warn({ chart: u.def.name, res: u.res, err }, 'chart refresh failed');
        });
      }, every);
    }, offset);
  });
}

export async function chartsRoutes(app: FastifyInstance): Promise<void> {
  for (const def of CHART_DEFS) {
    app.get(`/charts/${def.name}`, async (req, reply) => {
      const qp = req.query as { res?: string; from?: string; to?: string };
      if (qp.from !== undefined && qp.to !== undefined && RANGE_META[def.name]) {
        const rawFrom = Number(qp.from), rawTo = Number(qp.to);
        const res: RangeRes = qp.res === '1m' ? '1m' : qp.res === '1h' ? '1h' : qp.res === '1M' ? '1M' : '1d';
        if (!Number.isFinite(rawFrom) || !Number.isFinite(rawTo)) {
          void reply.status(400); return { error: 'bad from/to' };
        }
        // Clamp to [0, now + one bucket] before the order check, so a window
        // lying entirely in the future is rejected rather than served empty.
        const { from: fromSec, to: toSec } = clampRange(rawFrom, rawTo, res);
        if (toSec <= fromSec) {
          void reply.status(400); return { error: 'bad from/to' };
        }
        let served: Awaited<ReturnType<typeof serveRange>>;
        try {
          served = await serveRange(def.name, res, fromSec, toSec);
        } catch (err) {
          if (err instanceof RangeTooWideError) { void reply.status(400); return { error: 'range too wide for resolution' }; }
          throw err;
        }
        const { body, etag, immutable } = served;
        void reply.header('cache-control', `public, max-age=${immutable ? 86400 : 60}`);
        void reply.header('etag', etag);
        const inm = req.headers['if-none-match'];
        if (typeof inm === 'string' && inm.split(',').map((s) => s.trim()).includes(etag)) { void reply.status(304); return null; }
        return body;
      }
      const raw = (req.query as { res?: string }).res;
      const res: Res = raw === '1h' ? '1h' : '1d';
      const body = await getBody(def, res);
      const eff: Res = res === '1h' && !hasHourly(def) ? '1d' : res;
      const entry = cache.get(cacheKey(def.name, eff));
      const etag = entry?.etag ?? computeEtag(body);

      void reply.header('cache-control', `public, max-age=${def.maxAgeSec}`);
      void reply.header('etag', etag);

      const inm = req.headers['if-none-match'];
      if (typeof inm === 'string') {
        const candidates = inm.split(',').map((s) => s.trim());
        if (candidates.includes(etag) || candidates.includes('*')) {
          void reply.status(304);
          return null;
        }
      }
      return body;
    });
  }
}
