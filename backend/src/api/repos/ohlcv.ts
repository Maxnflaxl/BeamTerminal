import { q } from '../../db.js';
import type { ResolvedPair } from './pairs.js';

/**
 * OHLCV repo: extracts the candle query + per-bucket BEAM/USD conversion that
 * was previously inline in routes/ohlcv.ts so both the JSON endpoint and the
 * chart.png endpoint share one source of truth for the (non-trivial)
 * USD-denominated candle math.
 */

export const INTERVALS = {
  '1m':  { table: 'candles_1m',  seconds: 60 },
  '5m':  { table: 'candles_5m',  seconds: 300 },
  '15m': { table: 'candles_15m', seconds: 900 },
  '1h':  { table: 'candles_1h',  seconds: 3600 },
  '4h':  { table: 'candles_4h',  seconds: 14_400 },
  '1d':  { table: 'candles_1d',  seconds: 86_400 },
} as const;
export type Interval = keyof typeof INTERVALS;

export type Denom = 'native' | 'usd';

export interface Candle {
  time: number; // epoch seconds
  open: number;
  high: number;
  low: number;
  close: number;
  /** groths of aid1, kept as string to preserve precision across the wire. */
  volume: string;
  trade_count: number;
}

interface CandleRow {
  bucket: Date;
  open: string;
  high: string;
  low: string;
  close: string;
  volume_aid1: string;
  trade_count: string;
}

interface OracleHistoryRow {
  ts: Date;
  beam_usd: string;
}

/**
 * Forward-fill no-trade buckets with flat candles (open=high=low=close=prev
 * close, zero volume). Continuous-aggregate candles only exist for buckets that
 * had trades, so the series is sparse — consumers that render it want the gaps
 * shown as flat price, not collapsed off an ordinal axis (the web chart) or
 * interpolated as a diagonal (the chart.png export). `candles` must be ascending
 * by time. Skips filling when it would synthesize more than `maxPoints` bars
 * (an illiquid pair whose loaded candles span a big window on a fine timeframe),
 * degrading to the sparse series rather than exploding the array.
 *
 * NOT applied inside `fetchCandles`: the JSON /pairs/:id/ohlcv endpoint must
 * keep returning only real candles (its `limit`/`more.to` pagination counts
 * rows), and the web frontend densifies client-side.
 */
export function densifyCandles(
  candles: Candle[],
  bucketSeconds: number,
  maxPoints = 5000,
): Candle[] {
  if (candles.length < 2) return candles;
  const first = candles[0]!.time;
  const last = candles[candles.length - 1]!.time;
  const span = Math.floor((last - first) / bucketSeconds) + 1;
  // Already gapless, or too sparse to fill without exploding the array.
  if (span <= candles.length || span > maxPoints) return candles;

  const out: Candle[] = [candles[0]!];
  for (let i = 1; i < candles.length; i += 1) {
    const prev = candles[i - 1]!;
    const cur = candles[i]!;
    const missing = Math.round((cur.time - prev.time) / bucketSeconds) - 1;
    for (let g = 1; g <= missing; g += 1) {
      out.push({
        time: prev.time + g * bucketSeconds,
        open: prev.close,
        high: prev.close,
        low: prev.close,
        close: prev.close,
        volume: '0',
        trade_count: 0,
      });
    }
    out.push(cur);
  }
  return out;
}

export interface FetchCandlesOpts {
  pair: ResolvedPair;
  interval: Interval;
  limit: number;
  /** Optional upper bound (epoch seconds). Defaults to now. */
  to?: number;
  denom: Denom;
}

export async function fetchCandles(opts: FetchCandlesOpts): Promise<Candle[]> {
  const { pair, interval, limit, denom } = opts;
  const cfg = INTERVALS[interval];
  const { poolIds, refPoolId, aid1, aid2 } = pair;

  const usdSide: 'aid2-per-aid1' | 'inverse' | 'unsupported' =
    aid1 === 0 ? 'aid2-per-aid1' : aid2 === 0 ? 'inverse' : 'unsupported';

  const toTs = opts.to ? new Date(opts.to * 1000) : new Date();

  // Price OHLC comes from the reference (deepest) tier; volume/trade_count are
  // summed across every tier of the pair over the reference's bucket window.
  // For a single-tier id `poolIds` is just `[refPoolId]`, so this reduces to
  // the per-pool series.
  const { rows } = await q<CandleRow>(
    `WITH ref AS (
       SELECT bucket, open, high, low, close, volume_aid1, trade_count
         FROM ${cfg.table}
        WHERE pool_id = $1 AND bucket < $2
        ORDER BY bucket DESC
        LIMIT $3
     ),
     vol AS (
       SELECT bucket, SUM(volume_aid1) AS volume_aid1, SUM(trade_count) AS trade_count
         FROM ${cfg.table}
        WHERE pool_id = ANY($4) AND bucket < $2
          AND bucket >= (SELECT min(bucket) FROM ref)
        GROUP BY bucket
     )
     SELECT ref.bucket,
            ref.open::text, ref.high::text, ref.low::text, ref.close::text,
            COALESCE(vol.volume_aid1, ref.volume_aid1)::text AS volume_aid1,
            COALESCE(vol.trade_count, ref.trade_count)::text  AS trade_count
       FROM ref
       LEFT JOIN vol USING (bucket)
      ORDER BY ref.bucket DESC`,
    [refPoolId, toTs, limit, poolIds],
  );

  // For USD denom we need the BEAM/USD reference per-candle. We pull every
  // oracle snapshot within the candle range AND the latest one as a fallback
  // for buckets older than our oracle history (e.g. backfilled trades).
  let oracleHistory: OracleHistoryRow[] = [];
  let fallbackUsd: number | null = null;
  if (denom === 'usd' && usdSide !== 'unsupported' && rows.length > 0) {
    const minTs = rows[rows.length - 1]!.bucket;
    const { rows: oh } = await q<OracleHistoryRow>(
      `SELECT ts, beam_usd::text
         FROM oracle_snapshots
        WHERE ts >= $1 AND ts <= $2
        ORDER BY ts ASC`,
      [minTs, toTs],
    );
    oracleHistory = oh;

    const { rows: latest } = await q<OracleHistoryRow>(
      'SELECT ts, beam_usd::text FROM oracle_snapshots ORDER BY ts DESC LIMIT 1',
    );
    if (latest[0]) fallbackUsd = Number(latest[0].beam_usd);
  }

  function beamUsdAt(t: Date): number | null {
    if (oracleHistory.length === 0) return fallbackUsd;
    let lo = 0;
    let hi = oracleHistory.length - 1;
    let bestIdx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (oracleHistory[mid]!.ts.getTime() <= t.getTime()) {
        bestIdx = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return bestIdx >= 0 ? Number(oracleHistory[bestIdx]!.beam_usd) : fallbackUsd;
  }

  return rows
    .reverse()
    .map((r) => {
      const time = Math.floor(r.bucket.getTime() / 1000);
      let open = Number(r.open);
      let high = Number(r.high);
      let low = Number(r.low);
      let close = Number(r.close);
      if (denom === 'usd' && usdSide !== 'unsupported') {
        const ref = beamUsdAt(r.bucket);
        if (ref !== null) {
          if (usdSide === 'aid2-per-aid1') {
            // aid2-per-aid1; USD-per-aid2 = beamUsd / native_price
            open = open > 0 ? ref / open : 0;
            high = high > 0 ? ref / high : 0;
            low = low > 0 ? ref / low : 0;
            close = close > 0 ? ref / close : 0;
            // when inverting, swap high/low
            [high, low] = [Math.max(open, high, low, close), Math.min(open, high, low, close)];
          } else {
            open *= ref;
            high *= ref;
            low *= ref;
            close *= ref;
          }
        }
      }
      return {
        time,
        open,
        high,
        low,
        close,
        volume: r.volume_aid1,
        trade_count: Number(r.trade_count),
      };
    });
}
