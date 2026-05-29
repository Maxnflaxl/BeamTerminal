import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { q } from '../../db.js';
import { fetchNetworkSeries, type NetworkSeries, type ChartPoint } from '../../services/networkStats.js';

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

// Per-day average network difficulty (mean across the day's blocks).
const DIFFICULTY_SQL = `
  SELECT EXTRACT(epoch FROM time_bucket(INTERVAL '1 day', block_ts))::bigint AS ts,
         AVG(difficulty)::float8 AS value
    FROM block_metrics
   WHERE difficulty > 0
   GROUP BY time_bucket(INTERVAL '1 day', block_ts)
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

// Coinbase kernels per day. BEAM emits exactly one coinbase OUTPUT per block,
// so the coinbase baseline equals the block count per day. Derived from the
// same block_metrics rows KERNELS_SQL sums over, so the two lines stay mutually
// consistent and this needs no extra backfill. (`fee == 0` is NOT a coinbase
// marker — early BEAM allowed zero-fee transactions, so some blocks carry
// multiple fee-0 kernels.)
const COINBASE_SQL = `
  SELECT EXTRACT(epoch FROM time_bucket(INTERVAL '1 day', block_ts))::bigint AS ts,
         COUNT(*)::float8 AS value
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

// Per-day DEX volume in USD. Daily granularity throughout (we don't actually
// need hourly precision for a multi-year chart). Materializes:
//   - per-day BEAM/USD from oracle_snapshots,
//   - per-day BEAM-paired cross-rates (best-liquidity pool per asset),
// then JOINs against trade_daily. Replaces the previous per-row LATERAL
// pattern which was O(N²) on pool_state_snapshots.
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
  )
  SELECT EXTRACT(epoch FROM day)::bigint AS ts,
         SUM(usd_value)::float8 AS value
    FROM priced
   WHERE usd_value IS NOT NULL
   GROUP BY day
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

// Per-day DEX-wide volatility index: TVL-weighted average of per-pool realized
// volatility across all pairs, in percent. Per-pool daily closes come from
// candles_1d; each pool's 30-day rolling annualized vol is weighted by that
// pool's end-of-day USD TVL (same cross-rate pricing as TVL_SQL — BEAM oracle
// for BEAM-quoted pools, best BEAM-paired pool's reserve ratio otherwise).
// Dust pools (TVL < $100) and pools without a full 30-return window are
// excluded so thin/new markets don't spike the index.
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
  )
  SELECT EXTRACT(epoch FROM pv.day)::bigint AS ts,
         (SUM(pv.vol * pt.tvl_usd) / NULLIF(SUM(pt.tvl_usd), 0))::float8 AS value
    FROM pool_vol pv
    JOIN pool_tvl pt ON pt.pool_id = pv.pool_id AND pt.day = pv.day
   WHERE pv.n >= 30 AND pv.vol IS NOT NULL
     AND pt.tvl_usd IS NOT NULL AND pt.tvl_usd >= 100
   GROUP BY pv.day
   ORDER BY pv.day
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
  /** SQL run by `runQuery`. Mutually exclusive with `fetch`. */
  sql?: string;
  /** Custom fetcher when the data isn't a single Postgres aggregate (e.g.
   *  pulling from the explorer's /hdrs endpoint). Returns a ready series. */
  fetch?: () => Promise<SeriesPoint[]>;
  /** Browser cache hint (the server-side cache is independent). */
  maxAgeSec: number;
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

const CHART_DEFS: ReadonlyArray<ChartDef> = [
  { name: 'hashrate',   sql: HASHRATE_SQL,   maxAgeSec: 600 },
  { name: 'kernels',    sql: KERNELS_SQL,    maxAgeSec: 600 },
  { name: 'coinbase',   sql: COINBASE_SQL,   maxAgeSec: 600 },
  { name: 'assets',     sql: ASSETS_SQL,     maxAgeSec: 600 },
  { name: 'dex-volume', sql: DEX_VOLUME_SQL, maxAgeSec: 1800 },
  { name: 'difficulty', sql: DIFFICULTY_SQL, maxAgeSec: 600 },
  { name: 'block-time', sql: BLOCK_TIME_SQL, maxAgeSec: 600 },
  { name: 'tvl',        sql: TVL_SQL,        maxAgeSec: 1800 },
  { name: 'beam-vol',   sql: BEAM_VOL_SQL,   maxAgeSec: 1800 },
  { name: 'dex-vol',    sql: DEX_VOL_SQL,    maxAgeSec: 1800 },
  // From the explorer's /hdrs endpoint (one fetch yields all ten).
  { name: 'transactions-daily',  fetch: netFetcher('daily_txs'),             maxAgeSec: 600 },
  { name: 'transactions-total',  fetch: netFetcher('total_txs'),             maxAgeSec: 600 },
  { name: 'txos-total',          fetch: netFetcher('total_mw_outputs'),      maxAgeSec: 600 },
  { name: 'utxos-total',         fetch: netFetcher('total_utxos'),           maxAgeSec: 600 },
  { name: 'shielded-ins-daily',  fetch: netFetcher('daily_sh_inputs'),       maxAgeSec: 600 },
  { name: 'shielded-ins-total',  fetch: netFetcher('total_sh_inputs'),       maxAgeSec: 600 },
  { name: 'shielded-outs-daily', fetch: netFetcher('daily_sh_outputs'),      maxAgeSec: 600 },
  { name: 'shielded-outs-total', fetch: netFetcher('total_sh_outputs'),      maxAgeSec: 600 },
  { name: 'contracts-total',     fetch: netFetcher('total_contracts'),       maxAgeSec: 600 },
  { name: 'fees-daily',          fetch: netFetcher('daily_fee_groth'),       maxAgeSec: 600 },
  { name: 'fees-total',          fetch: netFetcher('total_fee_groth'),       maxAgeSec: 600 },
  { name: 'contract-calls-daily',fetch: netFetcher('daily_contract_calls'),  maxAgeSec: 600 },
  { name: 'contract-calls-total',fetch: netFetcher('total_contract_calls'),  maxAgeSec: 600 },
];

const REFRESH_INTERVAL_MS = 30 * 60 * 1000;

interface CacheEntry {
  series: SeriesPoint[] | null;
  /** SHA-1 of the JSON body, used to short-circuit If-None-Match requests
   *  with a 304 once the client has cached this version. */
  etag: string | null;
  refreshedAt: number;
  inflight: Promise<SeriesPoint[]> | null;
}

const cache = new Map<string, CacheEntry>();

function computeEtag(series: SeriesPoint[]): string {
  // Stable JSON of just `{series:[...]}` since that's what the route returns.
  const body = JSON.stringify({ series });
  return `"${createHash('sha1').update(body).digest('hex')}"`;
}

async function runQuery(def: ChartDef): Promise<SeriesPoint[]> {
  const t0 = Date.now();
  let series: SeriesPoint[];
  if (def.fetch) {
    series = await def.fetch();
  } else if (def.sql) {
    const { rows } = await q<Row>(def.sql);
    series = toSeries(rows);
  } else {
    throw new Error(`chart ${def.name} has neither sql nor fetch`);
  }
  // eslint-disable-next-line no-console -- Fastify pino logger is per-request.
  console.log(`[charts] ${def.name} refreshed: ${series.length} pts in ${Date.now() - t0}ms`);
  return series;
}

async function refresh(def: ChartDef): Promise<SeriesPoint[]> {
  const existing = cache.get(def.name);
  if (existing?.inflight) return existing.inflight;
  const inflight = runQuery(def);
  cache.set(def.name, {
    series: existing?.series ?? null,
    etag:   existing?.etag   ?? null,
    refreshedAt: existing?.refreshedAt ?? 0,
    inflight,
  });
  try {
    const series = await inflight;
    cache.set(def.name, { series, etag: computeEtag(series), refreshedAt: Date.now(), inflight: null });
    return series;
  } catch (err) {
    cache.set(def.name, {
      series: existing?.series ?? null,
      etag:   existing?.etag   ?? null,
      refreshedAt: existing?.refreshedAt ?? 0,
      inflight: null,
    });
    throw err;
  }
}

async function getSeries(def: ChartDef): Promise<SeriesPoint[]> {
  const entry = cache.get(def.name);
  if (entry?.series && !entry.inflight) return entry.series;
  if (entry?.inflight) {
    // First-request-after-boot waits for the in-flight pre-warm.
    return entry.series ?? entry.inflight;
  }
  return refresh(def);
}

/** Kick off pre-warm + periodic refresh. Call once on API startup. */
export function startChartCacheRefresher(): void {
  // Serial pre-warm — don't slam Postgres with seven heavy queries at once.
  void (async () => {
    for (const def of CHART_DEFS) {
      await refresh(def).catch((err) => {
        // eslint-disable-next-line no-console
        console.warn(`[charts] pre-warm failed for ${def.name}:`, err instanceof Error ? err.message : err);
      });
    }
  })();
  // Periodic refresh runs each chart on its own offset to spread DB load.
  CHART_DEFS.forEach((def, i) => {
    const offset = (REFRESH_INTERVAL_MS / CHART_DEFS.length) * i;
    setTimeout(() => {
      setInterval(() => {
        refresh(def).catch((err) => {
          // eslint-disable-next-line no-console
          console.warn(`[charts] refresh failed for ${def.name}:`, err instanceof Error ? err.message : err);
        });
      }, REFRESH_INTERVAL_MS);
    }, offset);
  });
}

export async function chartsRoutes(app: FastifyInstance): Promise<void> {
  for (const def of CHART_DEFS) {
    app.get(`/charts/${def.name}`, async (req, reply) => {
      const series = await getSeries(def);
      const entry = cache.get(def.name);
      const etag = entry?.etag ?? computeEtag(series);

      void reply.header('cache-control', `public, max-age=${def.maxAgeSec}`);
      void reply.header('etag', etag);

      // If-None-Match: list of quoted ETags or "*". Honour any direct match
      // and short-circuit with 304 + empty body.
      const inm = req.headers['if-none-match'];
      if (typeof inm === 'string') {
        const candidates = inm.split(',').map((s) => s.trim());
        if (candidates.includes(etag) || candidates.includes('*')) {
          void reply.status(304);
          return null;
        }
      }
      return { series };
    });
  }
}
