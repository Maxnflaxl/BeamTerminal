// Range-mode ("zoom") support for /charts: tile-quantized bounded cache + helpers.
// Kept separate from the legacy fixed-key `cache` in charts.ts (never-evicting Map,
// safe only for its fixed CHART_DEFS×{1h,1d} keyspace). This keyspace is open-ended.
import { createHash } from 'node:crypto';
import { q } from '../../db.js';
import { fetchNetworkRangeByHeight, resToDh, type ExplorerRow } from '../../services/networkStats.js';
import { bridgeTransfers, bridgeTransfersTotal, bridgeFees, bridgeFeesTotal } from '../repos/bridgeSeries.js';
import { bridgeTvlSeries, bridgeTvlByAsset, type Bucket as BridgeBucket } from '../../services/bridgeTvl.js';

export type Res = '1m' | '1h' | '1d' | '1M';

// '1M' has no fixed width — it never reaches the tile arithmetic below, so it's
// excluded from every fixed-width table and signature (see serveRange's '1M' branch).
export type TiledRes = Exclude<Res, '1M'>;

export const BUCKET_SECONDS: Record<TiledRes, number> = { '1m': 60, '1h': 3600, '1d': 86_400 };
export const TILE_BUCKETS = 256;
export const MAX_POINTS = 2000;

export interface RangePoint { ts: number; value: number }

export function tileSpan(res: TiledRes): number {
  return BUCKET_SECONDS[res] * TILE_BUCKETS;
}

/** Floor `from` / ceil `to` onto the bucket grid — result is always a superset. */
export function alignRange(fromSec: number, toSec: number, res: TiledRes): { from: number; to: number } {
  const b = BUCKET_SECONDS[res];
  return { from: Math.floor(fromSec / b) * b, to: Math.ceil(toSec / b) * b };
}

/** Ascending tile-start epochs whose [start, start+tileSpan) cover [from, to). */
export function tilesFor(fromSec: number, toSec: number, res: TiledRes): number[] {
  const span = tileSpan(res);
  const first = Math.floor(fromSec / span) * span;
  const out: number[] = [];
  for (let t = first; t < toSec; t += span) out.push(t);
  return out;
}

export function etagOf(body: unknown): string {
  return `"${createHash('sha1').update(JSON.stringify(body)).digest('hex')}"`;
}

interface CacheEntry { body: unknown; etag: string; expiresAt: number }

const MAX_ENTRIES = 400;
const FRESH_TTL_MS = 60_000;          // windows overlapping `now`
const IMMUTABLE_TTL_MS = 24 * 3_600_000; // fully-settled historical tiles

/**
 * Bounded access-order LRU with per-entry TTL and in-flight dedupe. Access-order
 * is maintained by delete+set (Map preserves insertion order), so the oldest key
 * is always the first — evict it when over capacity.
 */
export class RangeCache {
  private map = new Map<string, CacheEntry>();
  private pending = new Map<string, Promise<unknown>>();

  get(key: string): CacheEntry | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= Date.now()) { this.map.delete(key); return undefined; }
    this.map.delete(key); this.map.set(key, e); // bump to most-recent
    return e;
  }

  set(key: string, body: unknown, immutable: boolean): CacheEntry {
    const entry: CacheEntry = {
      body,
      etag: etagOf(body),
      expiresAt: Date.now() + (immutable ? IMMUTABLE_TTL_MS : FRESH_TTL_MS),
    };
    this.map.delete(key);
    this.map.set(key, entry);
    while (this.map.size > MAX_ENTRIES) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
    return entry;
  }

  /** Dedupe concurrent identical computations (e.g. a burst of pans). */
  async inflight<T>(key: string, compute: () => Promise<T>): Promise<T> {
    const existing = this.pending.get(key);
    if (existing) return existing as Promise<T>;
    const p = compute().finally(() => this.pending.delete(key));
    this.pending.set(key, p);
    return p;
  }
}

const PG_INTERVAL: Record<TiledRes, string> = { '1m': "INTERVAL '1 minute'", '1h': "INTERVAL '1 hour'", '1d': "INTERVAL '1 day'" };

// Per-bucket value expressions over `block_metrics`/`oracle_snapshots`, bucketed
// by $B on the scan's timestamp column, windowed to [$from, $to). Mirrors the
// legacy hourly SQL bodies but with a request-sized window, never a 35d constant.
function simpleLevelSql(res: TiledRes, fromSec: number, toSec: number, opts: {
  table: 'block_metrics' | 'oracle_snapshots';
  tsCol: 'block_ts' | 'ts';
  value: string;          // aggregate expression
  where?: string;         // extra predicate, ANDed
  having?: string;        // optional HAVING
}): string {
  const B = PG_INTERVAL[res];
  const extra = opts.where ? `AND ${opts.where}` : '';
  const having = opts.having ? `HAVING ${opts.having}` : '';
  return `
    SELECT EXTRACT(epoch FROM time_bucket(${B}, ${opts.tsCol}))::bigint AS ts,
           ${opts.value} AS value
      FROM ${opts.table}
     WHERE ${opts.tsCol} >= to_timestamp(${fromSec})
       AND ${opts.tsCol} <  to_timestamp(${toSec})
       ${extra}
     GROUP BY time_bucket(${B}, ${opts.tsCol})
     ${having}
     ORDER BY 1
  `;
}

function tvlRangeSql(res: TiledRes, fromSec: number, toSec: number): string {
  const B = PG_INTERVAL[res];
  // Same cross-rate pricing as TVL_HOURLY_SQL, bucketed at $B over [from,to).
  // Raw pool_state_snapshots scan (candles carry no reserves) — bounded window
  // keeps it cheap; a pool_state cagg is a noted follow-up if 1m TVL gets hot.
  return `
    WITH oracle_b AS (
      SELECT time_bucket(${B}, ts) AS b, last(beam_usd, ts) AS beam_usd
        FROM oracle_snapshots
       WHERE ts >= to_timestamp(${fromSec}) AND ts < to_timestamp(${toSec})
       GROUP BY 1
    ),
    pool_b AS (
      SELECT pool_id, time_bucket(${B}, ts) AS b,
             last(reserve1, ts)::numeric AS reserve1, last(reserve2, ts)::numeric AS reserve2
        FROM pool_state_snapshots
       WHERE ts >= to_timestamp(${fromSec}) AND ts < to_timestamp(${toSec})
       GROUP BY pool_id, time_bucket(${B}, ts)
    ),
    beam_paired AS (
      SELECT DISTINCT ON (pb.b, p.aid2)
             pb.b, p.aid2 AS asset_aid,
             pb.reserve1::numeric AS beam_reserve, pb.reserve2::numeric AS asset_reserve
        FROM pool_b pb JOIN pools p ON p.pool_id = pb.pool_id
       WHERE p.aid1 = 0 AND pb.reserve1 > 0 AND pb.reserve2 > 0
       ORDER BY pb.b, p.aid2, pb.reserve1 DESC
    ),
    priced AS (
      SELECT pb.b,
             CASE
               WHEN p.aid1 = 0 AND od.beam_usd IS NOT NULL THEN
                 2 * (pb.reserve1 / 1e8::numeric) * od.beam_usd
               WHEN bp1.beam_reserve IS NOT NULL AND od.beam_usd IS NOT NULL THEN
                 2 * (pb.reserve1 / power(10::numeric, a1.decimals))
                   * (bp1.beam_reserve / 1e8::numeric)
                   / NULLIF(bp1.asset_reserve / power(10::numeric, a1.decimals), 0) * od.beam_usd
               WHEN bp2.beam_reserve IS NOT NULL AND od.beam_usd IS NOT NULL THEN
                 2 * (pb.reserve2 / power(10::numeric, a2.decimals))
                   * (bp2.beam_reserve / 1e8::numeric)
                   / NULLIF(bp2.asset_reserve / power(10::numeric, a2.decimals), 0) * od.beam_usd
             END AS tvl_usd
        FROM pool_b pb
        JOIN pools  p  ON p.pool_id = pb.pool_id
        JOIN assets a1 ON a1.aid = p.aid1
        JOIN assets a2 ON a2.aid = p.aid2
        LEFT JOIN oracle_b    od  ON od.b  = pb.b
        LEFT JOIN beam_paired bp1 ON bp1.b = pb.b AND bp1.asset_aid = p.aid1
        LEFT JOIN beam_paired bp2 ON bp2.b = pb.b AND bp2.asset_aid = p.aid2
       WHERE pb.reserve1 > 0 OR pb.reserve2 > 0
    )
    SELECT EXTRACT(epoch FROM b)::bigint AS ts, SUM(tvl_usd)::float8 AS value
      FROM priced WHERE tvl_usd IS NOT NULL GROUP BY b ORDER BY 1
  `;
}

function assetsRangeSql(res: TiledRes, fromSec: number, toSec: number): string {
  const B = PG_INTERVAL[res];
  // Cumulative confidential-asset count, seeded with the pre-window baseline.
  return `
    WITH resolved AS (
      SELECT EXTRACT(epoch FROM bm.block_ts)::bigint AS ts
        FROM assets a JOIN block_metrics bm ON bm.height = a.lock_height
       WHERE a.aid > 0 AND a.lock_height IS NOT NULL
    ),
    baseline AS (SELECT COUNT(*)::numeric AS n FROM resolved WHERE ts < ${fromSec}),
    per_bucket AS (
      SELECT time_bucket(${B}, to_timestamp(ts)) AS b, COUNT(*) AS added
        FROM resolved WHERE ts >= ${fromSec} AND ts < ${toSec} GROUP BY 1
    )
    SELECT EXTRACT(epoch FROM b)::bigint AS ts,
           ((SELECT n FROM baseline) + SUM(added) OVER (ORDER BY b))::float8 AS value
      FROM per_bucket ORDER BY b
  `;
}

export function buildLevelRangeSql(name: string, res: TiledRes, fromSec: number, toSec: number): string {
  switch (name) {
    case 'price':
      return simpleLevelSql(res, fromSec, toSec, {
        table: 'oracle_snapshots', tsCol: 'ts', value: 'last(beam_usd, ts)::float8', where: 'beam_usd IS NOT NULL',
      });
    case 'hashrate':
      return simpleLevelSql(res, fromSec, toSec, {
        table: 'block_metrics', tsCol: 'block_ts',
        value: "(SUM(difficulty)::float8 / NULLIF(EXTRACT(epoch FROM MAX(block_ts) - MIN(block_ts)), 0))::float8",
        where: 'difficulty > 0', having: 'COUNT(*) > 1',
      });
    case 'difficulty':
      return simpleLevelSql(res, fromSec, toSec, {
        table: 'block_metrics', tsCol: 'block_ts', value: 'AVG(difficulty)::float8', where: 'difficulty > 0',
      });
    case 'block-time':
      return simpleLevelSql(res, fromSec, toSec, {
        table: 'block_metrics', tsCol: 'block_ts',
        value: '(EXTRACT(epoch FROM MAX(block_ts) - MIN(block_ts)) / NULLIF(COUNT(*) - 1, 0))::float8',
        having: 'COUNT(*) > 1',
      });
    case 'tvl':    return tvlRangeSql(res, fromSec, toSec);
    case 'assets': return assetsRangeSql(res, fromSec, toSec);
    default: throw new Error(`buildLevelRangeSql: not a level chart: ${name}`);
  }
}

const CANDLES_TABLE: Record<TiledRes, string> = { '1m': 'candles_1m', '1h': 'candles_1h', '1d': 'candles_1d' };
const SECS_PER_DAY = 86_400;

export function buildRateRangeSql(name: 'coinbase' | 'dex-volume', res: TiledRes, fromSec: number, toSec: number): string {
  const B = PG_INTERVAL[res];
  const bucketSec = BUCKET_SECONDS[res];
  const windowRows = Math.round(SECS_PER_DAY / bucketSec); // buckets in a trailing 24h
  const lookbackFrom = fromSec - SECS_PER_DAY;

  if (name === 'coinbase') {
    return `
      WITH per_bucket AS (
        SELECT time_bucket(${B}, block_ts) AS b, COUNT(*)::numeric AS n
          FROM block_metrics
         WHERE block_ts >= to_timestamp(${lookbackFrom}) AND block_ts < to_timestamp(${toSec})
         GROUP BY 1
      ),
      spine AS (
        SELECT generate_series(
                 time_bucket(${B}, to_timestamp(${lookbackFrom})),
                 time_bucket(${B}, to_timestamp(${toSec - bucketSec})),
                 ${B}
               ) AS b
      ),
      filled AS (SELECT s.b, COALESCE(p.n, 0) AS n FROM spine s LEFT JOIN per_bucket p ON p.b = s.b),
      rolled AS (
        SELECT b,
               SUM(n)   OVER (ORDER BY b ROWS BETWEEN ${windowRows - 1} PRECEDING AND CURRENT ROW) AS n24,
               COUNT(*) OVER (ORDER BY b ROWS BETWEEN ${windowRows - 1} PRECEDING AND CURRENT ROW) AS w
          FROM filled
      )
      SELECT EXTRACT(epoch FROM b)::bigint AS ts, n24::float8 AS value
        FROM rolled
       WHERE w = ${windowRows} AND b >= to_timestamp(${fromSec})
       ORDER BY 1
    `;
  }

  // dex-volume: per-bucket USD volume from candles_<res> + cross-rate, then trailing-24h.
  return `
    WITH oracle_b AS (
      SELECT time_bucket(${B}, ts) AS b, last(beam_usd, ts) AS beam_usd
        FROM oracle_snapshots
       WHERE ts >= to_timestamp(${lookbackFrom}) AND ts < to_timestamp(${toSec})
       GROUP BY 1
    ),
    pool_b AS (
      SELECT pool_id, time_bucket(${B}, ts) AS b,
             last(reserve1, ts)::numeric AS reserve1, last(reserve2, ts)::numeric AS reserve2
        FROM pool_state_snapshots
       WHERE ts >= to_timestamp(${lookbackFrom}) AND ts < to_timestamp(${toSec})
       GROUP BY pool_id, time_bucket(${B}, ts)
    ),
    beam_paired AS (
      SELECT DISTINCT ON (pb.b, p.aid2)
             pb.b, p.aid2 AS asset_aid,
             pb.reserve1::numeric AS beam_reserve, pb.reserve2::numeric AS asset_reserve
        FROM pool_b pb JOIN pools p ON p.pool_id = pb.pool_id
       WHERE p.aid1 = 0 AND pb.reserve1 > 0 AND pb.reserve2 > 0
       ORDER BY pb.b, p.aid2, pb.reserve1 DESC
    ),
    vol_b AS (
      SELECT pool_id, time_bucket(${B}, bucket) AS b,
             SUM(volume_aid1)::numeric AS vol1, SUM(volume_aid2)::numeric AS vol2
        FROM ${CANDLES_TABLE[res]}
       WHERE bucket >= to_timestamp(${lookbackFrom}) AND bucket < to_timestamp(${toSec})
       GROUP BY pool_id, time_bucket(${B}, bucket)
    ),
    priced AS (
      SELECT vb.b,
             CASE
               WHEN p.aid1 = 0 AND od.beam_usd IS NOT NULL THEN (vb.vol1 / 1e8::numeric) * od.beam_usd
               WHEN bp1.beam_reserve IS NOT NULL AND od.beam_usd IS NOT NULL THEN
                 (vb.vol1 / power(10::numeric, a1.decimals)) * (bp1.beam_reserve / 1e8::numeric)
                  / NULLIF(bp1.asset_reserve / power(10::numeric, a1.decimals), 0) * od.beam_usd
               WHEN bp2.beam_reserve IS NOT NULL AND od.beam_usd IS NOT NULL THEN
                 (vb.vol2 / power(10::numeric, a2.decimals)) * (bp2.beam_reserve / 1e8::numeric)
                  / NULLIF(bp2.asset_reserve / power(10::numeric, a2.decimals), 0) * od.beam_usd
             END AS usd
        FROM vol_b vb
        JOIN pools  p  ON p.pool_id = vb.pool_id
        JOIN assets a1 ON a1.aid = p.aid1
        JOIN assets a2 ON a2.aid = p.aid2
        LEFT JOIN oracle_b    od  ON od.b  = vb.b
        LEFT JOIN beam_paired bp1 ON bp1.b = vb.b AND bp1.asset_aid = p.aid1
        LEFT JOIN beam_paired bp2 ON bp2.b = vb.b AND bp2.asset_aid = p.aid2
    ),
    bucket_usd AS (SELECT b, SUM(usd)::float8 AS value FROM priced WHERE usd IS NOT NULL GROUP BY b),
    spine AS (
      SELECT generate_series(
               time_bucket(${B}, to_timestamp(${lookbackFrom})),
               time_bucket(${B}, to_timestamp(${toSec - bucketSec})),
               ${B}
             ) AS b
    ),
    filled AS (SELECT s.b, COALESCE(d.value, 0) AS value FROM spine s LEFT JOIN bucket_usd d ON d.b = s.b),
    rolled AS (
      SELECT b,
             SUM(value) OVER (ORDER BY b ROWS BETWEEN ${windowRows - 1} PRECEDING AND CURRENT ROW) AS v24,
             COUNT(*)   OVER (ORDER BY b ROWS BETWEEN ${windowRows - 1} PRECEDING AND CURRENT ROW) AS w
        FROM filled
    )
    SELECT EXTRACT(epoch FROM b)::bigint AS ts, v24::float8 AS value
      FROM rolled
     WHERE w = ${windowRows} AND b >= to_timestamp(${fromSec})
     ORDER BY 1
  `;
}

/** Canonical height↔ts: block_metrics is full-chain backfilled + height/ts indexed. */
export async function heightAtOrBefore(toSec: number): Promise<number | null> {
  const { rows } = await q<{ height: string }>(
    `SELECT height FROM block_metrics WHERE block_ts <= to_timestamp($1) ORDER BY block_ts DESC LIMIT 1`,
    [toSec],
  );
  return rows[0] ? Number(rows[0].height) : null;
}

function passthroughCol(rows: ExplorerRow[], code: string, fromSec: number): RangePoint[] {
  const out: RangePoint[] = [];
  for (const r of rows) { const v = r.values[code]; if (v !== undefined && r.ts >= fromSec) out.push({ ts: r.ts, value: v }); }
  return out;
}

// Trailing-24h delta of a cumulative column at row granularity, then trimmed to [from,to).
function trailing24hCol(rows: ExplorerRow[], code: string, fromSec: number): RangePoint[] {
  const out: RangePoint[] = [];
  let lo = 0;
  for (let hi = 0; hi < rows.length; hi += 1) {
    const cur = rows[hi]!.values[code];
    if (cur === undefined) continue;
    const cutoff = rows[hi]!.ts - SECS_PER_DAY;
    while (lo + 1 < hi && rows[lo + 1]!.ts <= cutoff) lo += 1;
    const base = rows[lo]!;
    if (base.ts > cutoff) continue;
    const bv = base.values[code];
    if (bv === undefined) continue;
    if (rows[hi]!.ts >= fromSec) out.push({ ts: rows[hi]!.ts, value: cur - bv });
  }
  return out;
}

/**
 * Explorer chart over [from,to) at `res`. `isDelta` charts (…/day) use a
 * trailing-24h delta and fetch 24h of lookback; `total_*` pass through.
 */
export async function explorerRangeSeries(col: string, isDelta: boolean, res: TiledRes, fromSec: number, toSec: number): Promise<RangePoint[]> {
  const hMax = await heightAtOrBefore(toSec);
  if (hMax === null) return [];
  const stopTs = isDelta ? fromSec - SECS_PER_DAY : fromSec;
  const rows = await fetchNetworkRangeByHeight(resToDh(res), hMax, stopTs);
  return isDelta ? trailing24hCol(rows, col, fromSec) : passthroughCol(rows, col, fromSec);
}

type Kind = 'level' | 'rate' | 'explorer' | 'daily-only' | 'multi';
const FULL: Res[] = ['1d', '1h', '1m'];
// For charts that also register `monthSeries` — the ladder is the single source
// of truth for whether '1M' is offered (see serveRange's '1M' branch).
export const FULL_M: Res[] = ['1d', '1h', '1m', '1M'];
const DAILY: Res[] = ['1d'];
// Bridge series only ever bucket by day or whole-calendar-month — there is no
// sub-daily bridge_messages granularity to offer, so '1h'/'1m' are absent.
const BRIDGE_LADDER: Res[] = ['1M', '1d'];

/** One split sub-series of a 'multi' chart, e.g. per-bridge or per-direction. */
export interface MultiSeriesGroup { key: string; label: string; points: RangePoint[] }

function bridgeBucketFor(res: Res): BridgeBucket {
  return res === '1M' ? 'month' : 'day';
}

// etagOf hashes JSON.stringify(body), so groups must come back in a stable
// order — an unordered SQL result would churn the ETag and defeat 304s.
// Plain comparison, not localeCompare: collation is locale/ICU-dependent and
// the ETag must not vary by environment.
function sortGroups(groups: MultiSeriesGroup[]): MultiSeriesGroup[] {
  return [...groups].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export async function bridgeMultiSeries(name: string, res: Res): Promise<MultiSeriesGroup[]> {
  const bucket = bridgeBucketFor(res);
  switch (name) {
    case 'bridge-transfers-by-direction':
      return sortGroups(await bridgeTransfers(bucket, 'direction'));
    case 'bridge-transfers-by-bridge':
      return sortGroups(await bridgeTransfers(bucket, 'bridge'));
    case 'bridge-tvl-by-asset': {
      const { series } = await bridgeTvlByAsset(bucket);
      // MultiSeriesGroup has no slot for BridgeAssetSeries.decimals — the points
      // are already scaled to real magnitude, so a fixed display precision on
      // the frontend covers every asset without needing per-series precision.
      return sortGroups(series.map(({ key, label, points }) => ({ key, label, points })));
    }
    default:
      throw new Error(`bridgeMultiSeries: unknown chart ${name}`);
  }
}

// Whole-history fetcher for the five single-shape bridge charts. Registered as
// `wholeSeries` so both the '1d' and '1M' rungs of their ladder are served —
// unlike the generic 'daily-only' tiled path, which returns [] for anything
// that isn't SQL-backed (see fetchTile).
export async function bridgeSingleSeries(name: string, res: Res): Promise<RangePoint[]> {
  const bucket = bridgeBucketFor(res);
  switch (name) {
    case 'bridge-transfers':       return (await bridgeTransfers(bucket, 'none'))[0]?.points ?? [];
    case 'bridge-transfers-total': return bridgeTransfersTotal(bucket);
    case 'bridge-fees':            return (await bridgeFees(bucket, 'none'))[0]?.points ?? [];
    case 'bridge-fees-total':      return bridgeFeesTotal(bucket);
    case 'bridge-tvl':             return bridgeTvlSeries(bucket);
    default: throw new Error(`bridgeSingleSeries: unknown chart ${name}`);
  }
}

export interface RangeMetaEntry {
  kind: Kind;
  col?: string;
  isDelta?: boolean;
  ladder: Res[];
  // Whole-history fetcher for the '1M' rung (see serveRange). Requires '1M' in
  // `ladder` too — omitting either keeps falling back to the ladder's coarsest
  // tiled resolution.
  monthSeries?: (name: string) => Promise<RangePoint[]>;
  // Whole-history fetcher for 'multi' kind charts — bypasses tiling like monthSeries.
  multiSeries?: (name: string, res: Res, fromSec: number, toSec: number) => Promise<MultiSeriesGroup[]>;
  // Whole-history fetcher covering every rung of `ladder` at once (not just
  // '1M' like monthSeries) — for charts with no SQL tile builder at all, so
  // `fetchTile`'s [] fallback is never reached for any requested res.
  wholeSeries?: (name: string, res: Res) => Promise<RangePoint[]>;
}

export const RANGE_META: Record<string, RangeMetaEntry> = {
  price: { kind: 'level', ladder: FULL }, tvl: { kind: 'level', ladder: FULL },
  hashrate: { kind: 'level', ladder: FULL }, difficulty: { kind: 'level', ladder: FULL },
  'block-time': { kind: 'level', ladder: FULL }, assets: { kind: 'level', ladder: FULL },
  coinbase: { kind: 'rate', ladder: FULL }, 'dex-volume': { kind: 'rate', ladder: FULL },
  // explorer (col = /hdrs column code; isDelta = "…/day" trailing-24h)
  'transactions-daily': { kind: 'explorer', col: 'K', isDelta: true, ladder: FULL },
  'transactions-total': { kind: 'explorer', col: 'K', isDelta: false, ladder: FULL },
  'txos-total': { kind: 'explorer', col: 'O', isDelta: false, ladder: FULL },
  'utxos-total': { kind: 'explorer', col: 'U', isDelta: false, ladder: FULL },
  'size-total': { kind: 'explorer', col: 'C', isDelta: false, ladder: FULL },
  'archive-total': { kind: 'explorer', col: 'A', isDelta: false, ladder: FULL },
  'shielded-ins-daily': { kind: 'explorer', col: 'Y', isDelta: true, ladder: FULL },
  'shielded-ins-total': { kind: 'explorer', col: 'Y', isDelta: false, ladder: FULL },
  'shielded-outs-daily': { kind: 'explorer', col: 'Z', isDelta: true, ladder: FULL },
  'shielded-outs-total': { kind: 'explorer', col: 'Z', isDelta: false, ladder: FULL },
  'contracts-total': { kind: 'explorer', col: 'B', isDelta: false, ladder: FULL },
  'fees-daily': { kind: 'explorer', col: 'F', isDelta: true, ladder: FULL },
  'fees-total': { kind: 'explorer', col: 'F', isDelta: false, ladder: FULL },
  'contract-calls-daily': { kind: 'explorer', col: 'P', isDelta: true, ladder: FULL },
  'contract-calls-total': { kind: 'explorer', col: 'P', isDelta: false, ladder: FULL },
  // daily-only: no finer tier
  'beam-vol': { kind: 'daily-only', ladder: DAILY }, 'dex-vol': { kind: 'daily-only', ladder: DAILY },
  blackhole: { kind: 'daily-only', ladder: DAILY },
  // Bridge multi-series: split per direction/bridge/asset, computed whole like
  // monthSeries rather than tiled — the source tables are small.
  'bridge-transfers-by-direction': { kind: 'multi', ladder: BRIDGE_LADDER, multiSeries: bridgeMultiSeries },
  'bridge-transfers-by-bridge': { kind: 'multi', ladder: BRIDGE_LADDER, multiSeries: bridgeMultiSeries },
  'bridge-tvl-by-asset': { kind: 'multi', ladder: BRIDGE_LADDER, multiSeries: bridgeMultiSeries },
  // Bridge single-series: no SQL tile builder exists for bridge_messages /
  // reconstructed TVL, so both the 'day' and 'month' rungs are served whole.
  'bridge-transfers': { kind: 'daily-only', ladder: BRIDGE_LADDER, wholeSeries: bridgeSingleSeries },
  'bridge-transfers-total': { kind: 'daily-only', ladder: BRIDGE_LADDER, wholeSeries: bridgeSingleSeries },
  'bridge-fees': { kind: 'daily-only', ladder: BRIDGE_LADDER, wholeSeries: bridgeSingleSeries },
  'bridge-fees-total': { kind: 'daily-only', ladder: BRIDGE_LADDER, wholeSeries: bridgeSingleSeries },
  'bridge-tvl': { kind: 'daily-only', ladder: BRIDGE_LADDER, wholeSeries: bridgeSingleSeries },
};

const rangeCache = new RangeCache();
const CONFIRMATION_SECONDS = 80 * 60; // 80 blocks × ~60s — a settled horizon

async function fetchTile(name: string, meta: RangeMetaEntry, res: TiledRes, tileStart: number, tileEnd: number): Promise<RangePoint[]> {
  if (meta.kind === 'level') { const { rows } = await q<{ ts: string; value: number | null }>(buildLevelRangeSql(name, res, tileStart, tileEnd)); return toRange(rows); }
  if (meta.kind === 'rate')  { const { rows } = await q<{ ts: string; value: number | null }>(buildRateRangeSql(name as 'coinbase' | 'dex-volume', res, tileStart, tileEnd)); return toRange(rows); }
  if (meta.kind === 'explorer') return explorerRangeSeries(meta.col!, !!meta.isDelta, res, tileStart, tileEnd);
  // daily-only / multi: neither goes through the tile grid — daily-only keeps its
  // legacy full-series body (frontend never zooms them) and multi is handled
  // entirely inside serveRange before fetchTile is ever called.
  return [];
}

function toRange(rows: ReadonlyArray<{ ts: string | number; value: number | null }>): RangePoint[] {
  const out: RangePoint[] = [];
  for (const r of rows) { if (r.value === null) continue; out.push({ ts: Number(r.ts), value: Number(r.value) }); }
  return out;
}

// `kind` is an explicit wire discriminant, not inferred from array shape:
// `{series: []}` is ambiguous between an empty single series and an empty
// multi-series window, so consumers must switch on `kind`, never on
// `'points' in series[0]`.
export type RangeBody =
  | { kind: 'single'; series: RangePoint[] }
  | { kind: 'multi'; series: MultiSeriesGroup[] };

export async function serveRange(name: string, res: Res, fromSec: number, toSec: number): Promise<{ body: RangeBody; etag: string; immutable: boolean }> {
  const meta = RANGE_META[name];
  if (!meta) throw new Error(`unknown chart: ${name}`);
  const nowSec = Math.floor(Date.now() / 1000);

  // Multi-series charts are split into a handful of small named series (e.g. per
  // bridge) that are cheap to compute whole, so they skip the tile grid entirely
  // rather than tiling each sub-series independently. Checked before '1M' so the
  // response shape is a function of the chart, never of the query param — a
  // multi chart does its own month bucketing inside `multiSeries` when `res`
  // is '1M', instead of ever falling into the flat single-series '1M' branch.
  if (meta.kind === 'multi') {
    if (!meta.multiSeries) throw new Error(`chart ${name}: kind 'multi' requires a multiSeries fetcher`);
    const key = `${name}:multi:${res}:${fromSec}:${toSec}`;
    const cached = rangeCache.get(key);
    if (cached) return { body: cached.body as RangeBody, etag: cached.etag, immutable: false };
    const body = await rangeCache.inflight(key, async (): Promise<RangeBody> => {
      const groups = await meta.multiSeries!(name, res, fromSec, toSec);
      const series: MultiSeriesGroup[] = groups.map((g) => ({
        key: g.key,
        label: g.label,
        points: g.points.filter((p) => p.ts >= fromSec && p.ts < toSec),
      }));
      return { kind: 'multi', series };
    });
    const entry = rangeCache.set(key, body, false);
    return { body, etag: entry.etag, immutable: false };
  }

  // A chart with no SQL tile builder (bridge singles) serves both rungs of its
  // ladder whole rather than falling into fetchTile's [] fallback. Checked
  // before '1M' so a plain '1d' request is covered too, not just the month tier.
  if (meta.wholeSeries) {
    const key = `${name}:whole:${res}`;
    const cached = rangeCache.get(key);
    const all = cached
      ? (cached.body as RangePoint[])
      : await rangeCache.inflight(key, async () => {
        const pts = await meta.wholeSeries!(name, res);
        rangeCache.set(key, pts, false);
        return pts;
      });
    const series = all.filter((p) => p.ts >= fromSec && p.ts < toSec);
    const body: RangeBody = { kind: 'single', series };
    return { body, etag: etagOf(body), immutable: false };
  }

  // A month has no fixed width, so it cannot ride the tile grid below. The month
  // tier is small enough (tens of buckets) to compute whole and slice, which is
  // what every '1M' request does — charts that never registered '1M' on their
  // ladder, or never registered a fetcher, just fall through to the normal
  // ladder resolution instead (ladder is the single source of truth here).
  if (res === '1M' && meta.ladder.includes('1M') && meta.monthSeries) {
    const monthKey = `${name}:1M:full`;
    const cachedMonth = rangeCache.get(monthKey);
    const all = cachedMonth
      ? (cachedMonth.body as RangePoint[])
      : await rangeCache.inflight(monthKey, async () => {
        const pts = await meta.monthSeries!(name);
        rangeCache.set(monthKey, pts, false);
        return pts;
      });
    const series = all.filter((p) => p.ts >= fromSec && p.ts < toSec);
    const body: RangeBody = { kind: 'single', series };
    return { body, etag: etagOf(body), immutable: false };
  }

  // Ladders are coarsest-first (e.g. ['1d','1h','1m']); fall back to the coarsest
  // tiled tier when the requested res isn't offered for this chart, or is '1M'
  // without a registered month fetcher.
  const tiledLadder = meta.ladder.filter((r): r is TiledRes => r !== '1M');
  if (tiledLadder.length === 0) throw new Error(`chart ${name}: ladder has no tiled resolution`);
  const effRes: TiledRes = res !== '1M' && tiledLadder.includes(res) ? res : tiledLadder[0]!;
  const { from, to } = alignRange(fromSec, toSec, effRes);

  const tiles = tilesFor(from, to, effRes);
  const span = tileSpan(effRes);
  const perTile = await Promise.all(tiles.map(async (tileStart) => {
    const tileEnd = tileStart + span;
    const key = `${name}:${effRes}:${tileStart}`;
    const cached = rangeCache.get(key);
    if (cached) return cached.body as RangePoint[];
    return rangeCache.inflight(key, async () => {
      const pts = await fetchTile(name, meta, effRes, tileStart, tileEnd);
      const immutable = tileEnd < nowSec - CONFIRMATION_SECONDS;
      rangeCache.set(key, pts, immutable);
      return pts;
    });
  }));

  // Concatenate tiles (ascending, non-overlapping) and slice to the exact aligned window.
  const merged: RangePoint[] = [];
  for (const pts of perTile) for (const p of pts) if (p.ts >= from && p.ts < to) merged.push(p);
  merged.sort((a, b) => a.ts - b.ts);
  const body: RangeBody = { kind: 'single', series: merged };
  const immutable = to < nowSec - CONFIRMATION_SECONDS;
  return { body, etag: etagOf(body), immutable };
}
