import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q } from '../../db.js';
import { BadRequest, NotFound } from '../error.js';
import { resolvePairId } from '../repos/pairs.js';

const INTERVALS = {
  '1m':  { table: 'candles_1m',  seconds: 60 },
  '5m':  { table: 'candles_5m',  seconds: 300 },
  '15m': { table: 'candles_15m', seconds: 900 },
  '1h':  { table: 'candles_1h',  seconds: 3600 },
  '4h':  { table: 'candles_4h',  seconds: 14_400 },
  '1d':  { table: 'candles_1d',  seconds: 86_400 },
} as const;
type Interval = keyof typeof INTERVALS;

const Query = z.object({
  interval: z.enum(['1m', '5m', '15m', '1h', '4h', '1d']).default('1h'),
  limit: z.coerce.number().int().min(1).max(2000).default(500),
  to: z.coerce.number().int().positive().optional(),
  denom: z.enum(['native', 'usd']).default('native'),
});

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

export async function ohlcvRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>('/pairs/:id/ohlcv', async (req, reply) => {
    const poolId = await resolvePairId(req.params.id);
    if (poolId === null) throw NotFound('PAIR_NOT_FOUND', `no pair ${req.params.id}`);

    const parsed = Query.safeParse(req.query);
    if (!parsed.success) {
      throw BadRequest('BAD_REQUEST', parsed.error.issues[0]?.message ?? 'invalid query');
    }
    const { interval, limit, to, denom } = parsed.data;
    const cfg = INTERVALS[interval as Interval];

    // Identify pair side for USD conversion (only valid when one side is BEAM).
    const { rows: poolMeta } = await q<{ aid1: string; aid2: string }>(
      `SELECT aid1::text, aid2::text FROM pools WHERE pool_id = $1`,
      [poolId],
    );
    if (poolMeta.length === 0) throw NotFound('PAIR_NOT_FOUND', `pool ${poolId} gone`);
    const aid1 = Number(poolMeta[0]!.aid1);
    const aid2 = Number(poolMeta[0]!.aid2);
    const usdSide: 'aid2-per-aid1' | 'inverse' | 'unsupported' =
      aid1 === 0 ? 'aid2-per-aid1' : aid2 === 0 ? 'inverse' : 'unsupported';

    const toTs = to ? new Date(to * 1000) : new Date();
    const { rows } = await q<CandleRow>(
      `SELECT bucket, open::text, high::text, low::text, close::text,
              volume_aid1::text, trade_count::text
         FROM ${cfg.table}
        WHERE pool_id = $1 AND bucket < $2
        ORDER BY bucket DESC
        LIMIT $3`,
      [poolId, toTs, limit],
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
      // Binary search for the latest snapshot at-or-before t.
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

    const candles = rows
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
          volume: r.volume_aid1, // groths of aid1 (string)
          trade_count: Number(r.trade_count),
        };
      });

    void reply.header('cache-control', 'public, max-age=30');
    return {
      candles,
      interval,
      denom,
      more: rows.length === limit && candles[0]
        ? { to: candles[0].time }
        : null,
    };
  });
}
