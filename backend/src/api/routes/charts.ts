import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { q } from '../../db.js';
import { fetchNetworkSeries, fetchNetworkSeriesHourly, type NetworkSeries, type ChartPoint } from '../../services/networkStats.js';
import { fetchBlackholeSeries } from '../../services/blackhole.js';
import { serveRange, RANGE_META, type Res as RangeRes } from './chart-range.js';

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

// Hourly hashrate — same Σdifficulty/Δt method as HASHRATE_SQL, bucketed hourly
// over a recent bounded window. Hashrate is a per-bucket rate, scale-invariant
// to bucket size, so no rolling window is needed.
const HASHRATE_HOURLY_SQL = `
  SELECT EXTRACT(epoch FROM time_bucket(INTERVAL '1 hour', block_ts))::bigint AS ts,
         (SUM(difficulty)::float8
            / NULLIF(EXTRACT(epoch FROM MAX(block_ts) - MIN(block_ts)), 0))::float8 AS value
    FROM block_metrics
   WHERE difficulty > 0
     AND block_ts > now() - INTERVAL '35 days'
   GROUP BY time_bucket(INTERVAL '1 hour', block_ts)
  HAVING COUNT(*) > 1
   ORDER BY 1
`;

// Per-day average block time in seconds (Δt across the day's blocks).
const BLOCK_TIME_SQL = `
  SELECT EXTRACT(epoch FROM time_bucket(INTERVAL '1 day', block_ts))::bigint AS ts,
         (EXTRACT(epoch FROM MAX(block_ts) - MIN(block_ts))
            / NULLIF(COUNT(*) - 1, 0))::float8 AS value
    FROM block_metrics
   GROUP BY time_bucket(INTERVAL '1 day', block_ts)
  HAVING COUNT(*) > 1
   ORDER BY 1
`;

const BLOCK_TIME_HOURLY_SQL = `
  SELECT EXTRACT(epoch FROM time_bucket(INTERVAL '1 hour', block_ts))::bigint AS ts,
         (EXTRACT(epoch FROM MAX(block_ts) - MIN(block_ts))
            / NULLIF(COUNT(*) - 1, 0))::float8 AS value
    FROM block_metrics
   WHERE block_ts > now() - INTERVAL '35 days'
   GROUP BY time_bucket(INTERVAL '1 hour', block_ts)
  HAVING COUNT(*) > 1
   ORDER BY 1
`;

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

// Per-day average network difficulty (mean across the day's blocks).
const DIFFICULTY_SQL = `
  SELECT EXTRACT(epoch FROM time_bucket(INTERVAL '1 day', block_ts))::bigint AS ts,
         AVG(difficulty)::float8 AS value
    FROM block_metrics
   WHERE difficulty > 0
   GROUP BY time_bucket(INTERVAL '1 day', block_ts)
   ORDER BY 1
`;

const DIFFICULTY_HOURLY_SQL = `
  SELECT EXTRACT(epoch FROM time_bucket(INTERVAL '1 hour', block_ts))::bigint AS ts,
         AVG(difficulty)::float8 AS value
    FROM block_metrics
   WHERE difficulty > 0
     AND block_ts > now() - INTERVAL '35 days'
   GROUP BY time_bucket(INTERVAL '1 hour', block_ts)
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
const PRICE_SQL = `
  SELECT EXTRACT(epoch FROM time_bucket(INTERVAL '1 day', ts))::bigint AS ts,
         last(beam_usd, ts)::float8 AS value
    FROM oracle_snapshots
   WHERE beam_usd IS NOT NULL
   GROUP BY time_bucket(INTERVAL '1 day', ts)
   ORDER BY 1
`;

// Hourly BEAM/USD close over a recent bounded window.
const PRICE_HOURLY_SQL = `
  SELECT EXTRACT(epoch FROM time_bucket(INTERVAL '1 hour', ts))::bigint AS ts,
         last(beam_usd, ts)::float8 AS value
    FROM oracle_snapshots
   WHERE beam_usd IS NOT NULL
     AND ts > now() - INTERVAL '35 days'
   GROUP BY time_bucket(INTERVAL '1 hour', ts)
   ORDER BY 1
`;

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
  { name: 'hashrate',   sql: HASHRATE_SQL,   hourlySql: HASHRATE_HOURLY_SQL,   maxAgeSec: 600 },
  { name: 'coinbase',   sql: COINBASE_SQL,   hourlySql: COINBASE_HOURLY_SQL,   maxAgeSec: 600 },
  { name: 'assets',     sql: ASSETS_SQL,     hourlySql: ASSETS_HOURLY_SQL,     maxAgeSec: 600 },
  { name: 'dex-volume', sql: DEX_VOLUME_SQL, hourlySql: DEX_VOLUME_HOURLY_SQL, maxAgeSec: 1800 },
  { name: 'difficulty', sql: DIFFICULTY_SQL, hourlySql: DIFFICULTY_HOURLY_SQL, maxAgeSec: 600 },
  { name: 'block-time', sql: BLOCK_TIME_SQL, hourlySql: BLOCK_TIME_HOURLY_SQL, maxAgeSec: 600 },
  { name: 'tvl',        sql: TVL_SQL,        hourlySql: TVL_HOURLY_SQL,        maxAgeSec: 1800 },
  { name: 'beam-vol',   sql: BEAM_VOL_SQL,   maxAgeSec: 1800 },
  { name: 'dex-vol',    sql: DEX_VOL_SQL,    maxAgeSec: 1800 },
  { name: 'price',      sql: PRICE_SQL,      hourlySql: PRICE_HOURLY_SQL,      maxAgeSec: 600 },
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
  // eslint-disable-next-line no-console -- Fastify pino logger is per-request.
  console.log(`[charts] ${def.name}:${res} refreshed: ${n} pts in ${Date.now() - t0}ms`);
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
      await refresh(u.def, u.res).catch((err) => {
        // eslint-disable-next-line no-console
        console.warn(`[charts] pre-warm failed for ${u.def.name}:${u.res}:`, err instanceof Error ? err.message : err);
      });
    }
  })();
  // Periodic refresh, each unit on its own offset to spread DB load.
  units.forEach((u, i) => {
    const offset = (REFRESH_INTERVAL_MS / units.length) * i;
    setTimeout(() => {
      setInterval(() => {
        refresh(u.def, u.res).catch((err) => {
          // eslint-disable-next-line no-console
          console.warn(`[charts] refresh failed for ${u.def.name}:${u.res}:`, err instanceof Error ? err.message : err);
        });
      }, REFRESH_INTERVAL_MS);
    }, offset);
  });
}

export async function chartsRoutes(app: FastifyInstance): Promise<void> {
  for (const def of CHART_DEFS) {
    app.get(`/charts/${def.name}`, async (req, reply) => {
      const qp = req.query as { res?: string; from?: string; to?: string };
      if (qp.from !== undefined && qp.to !== undefined && RANGE_META[def.name]) {
        const fromSec = Number(qp.from), toSec = Number(qp.to);
        const res: RangeRes = qp.res === '1m' ? '1m' : qp.res === '1h' ? '1h' : '1d';
        if (!Number.isFinite(fromSec) || !Number.isFinite(toSec) || toSec <= fromSec) {
          void reply.status(400); return { error: 'bad from/to' };
        }
        const { body, etag, immutable } = await serveRange(def.name, res, fromSec, toSec);
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
