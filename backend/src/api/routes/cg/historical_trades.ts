import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q } from '../../../db.js';
import { BadRequest, NotFound } from '../../error.js';

/**
 * CoinGecko `/historical_trades/{ticker_id}` per docs/CoinGecko.md §Endpoint 3.
 *
 *   ticker_id = "<aid1>_<aid2>_<kind>"
 *
 * Returns confirmed trades only. Split into `buy` and `sell` arrays per the
 * spec. `trade_timestamp` is unix SECONDS (per CG spec).
 *
 * Buy/sell convention (per CG): "buy" = the base (aid1) was bought. Per the AMM
 * contract's Trade primitive (m_Buy1 = buy aid1; FundsUnlock aid1, FundsLock aid2),
 * that's a swap where the user paid the target (aid2) and received the base (aid1)
 * — so aid_in == aid2.
 */

const Query = z.object({
  type: z.enum(['buy', 'sell']).optional(),
  limit: z.coerce.number().int().min(0).max(500).default(100),
  start_time: z.coerce.number().int().nonnegative().optional(),
  end_time: z.coerce.number().int().nonnegative().optional(),
});

interface TradeRow {
  trade_id: string;
  block_ts: Date;
  aid_in: string;
  volume_aid1: string;
  volume_aid2: string;
  price_native: string;
  decimals1: number;
  decimals2: number;
}

interface PoolMetaRow {
  pool_id: string;
  aid1: string;
  decimals1: number;
  decimals2: number;
}

function toDecimal(n: number, maxFractionDigits = 18): string {
  if (!Number.isFinite(n)) return '0';
  // Number#toFixed switches to exponent notation at 1e21; render such
  // magnitudes through BigInt instead. Every double that large is already an
  // integer, so no fractional digits are lost.
  let s = Math.abs(n) >= 1e21
    ? BigInt(n).toString()
    : n.toFixed(Math.min(maxFractionDigits, 20));
  if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s || '0';
}

export async function cgHistoricalTradesRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { ticker_id: string } }>(
    '/historical_trades/:ticker_id',
    async (req, reply) => {
      const m = req.params.ticker_id.match(/^(\d+)_(\d+)_(\d)$/);
      if (!m) throw BadRequest('BAD_TICKER_ID', `ticker_id must be "<aid1>_<aid2>_<kind>"`);
      const aid1 = Number(m[1]);
      const aid2 = Number(m[2]);
      const kind = Number(m[3]);

      // Resolve the pool. Destroyed pools and pools with an imposter on either
      // side are excluded from /cg/* entirely, so they resolve as not found.
      const { rows: poolRows } = await q<PoolMetaRow>(
        `SELECT p.pool_id::text, p.aid1::text,
                a1.decimals AS decimals1, a2.decimals AS decimals2
           FROM pools p
           JOIN assets a1 ON a1.aid = p.aid1
           JOIN assets a2 ON a2.aid = p.aid2
          WHERE p.aid1 = $1 AND p.aid2 = $2 AND p.kind = $3
            AND p.destroyed_at_height IS NULL
            AND NOT a1.is_imposter AND NOT a2.is_imposter`,
        [aid1, aid2, kind],
      );
      const pool = poolRows[0];
      if (!pool) {
        throw NotFound('PAIR_NOT_FOUND', `no active pair ${req.params.ticker_id}`);
      }

      const parsed = Query.safeParse(req.query);
      if (!parsed.success) {
        throw BadRequest('BAD_REQUEST', parsed.error.issues[0]?.message ?? 'invalid query');
      }
      const opts = parsed.data;

      const args: Array<string | number | Date> = [pool.pool_id];
      // Priced trades only — the same predicate the OHLCV aggregates use, so a
      // trade that would print as "0" here never appears at all.
      const filters: string[] = [
        'confirmed = TRUE',
        't.price_native IS NOT NULL',
        't.price_native > 0',
      ];
      // buy = base (aid1) acquired ⇒ target (aid2) paid in, so aid_in != aid1.
      if (opts.type !== undefined) {
        args.push(pool.aid1);
        filters.push(opts.type === 'buy' ? `t.aid_in <> $${args.length}` : `t.aid_in = $${args.length}`);
      }
      if (opts.start_time !== undefined) {
        args.push(new Date(opts.start_time * 1000));
        filters.push(`block_ts >= $${args.length}`);
      }
      if (opts.end_time !== undefined) {
        args.push(new Date(opts.end_time * 1000));
        filters.push(`block_ts <= $${args.length}`);
      }
      // limit=0 means "full history" per spec; cap at 5000 for safety.
      const limit = opts.limit === 0 ? 5000 : opts.limit;
      args.push(limit);
      const limitParam = args.length;

      const { rows } = await q<TradeRow>(
        `SELECT t.trade_id::text, t.block_ts, t.aid_in::text,
                t.volume_aid1::text, t.volume_aid2::text, t.price_native::text,
                ${pool.decimals1} AS decimals1, ${pool.decimals2} AS decimals2
           FROM trades t
          WHERE t.pool_id = $1 AND ${filters.join(' AND ')}
          ORDER BY t.block_ts DESC
          LIMIT $${limitParam}`,
        args,
      );

      const buy: ReturnType<typeof formatTrade>[] = [];
      const sell: ReturnType<typeof formatTrade>[] = [];
      const aid1Pool = Number(pool.aid1);
      for (const r of rows) {
        const isBuy = Number(r.aid_in) !== aid1Pool;
        (isBuy ? buy : sell).push(formatTrade(r, isBuy));
      }

      void reply.header('cache-control', 'public, max-age=15');
      return { buy, sell };
    },
  );
}

function formatTrade(r: TradeRow, isBuy: boolean) {
  const baseVol = Number(r.volume_aid1) / 10 ** r.decimals1;
  const targetVol = Number(r.volume_aid2) / 10 ** r.decimals2;
  const price = Number(r.price_native);
  return {
    trade_id: Number(r.trade_id),
    price: toDecimal(price),
    base_volume: toDecimal(baseVol),
    target_volume: toDecimal(targetVol),
    trade_timestamp: Math.floor(r.block_ts.getTime() / 1000), // unix seconds per CG spec
    type: isBuy ? 'buy' : 'sell',
  };
}
