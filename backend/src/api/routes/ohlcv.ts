import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BadRequest, NotFound } from '../error.js';
import { resolvePair } from '../repos/pairs.js';
import { fetchCandles, type Interval } from '../repos/ohlcv.js';

const Query = z.object({
  interval: z.enum(['1m', '5m', '15m', '1h', '4h', '1d']).default('1h'),
  limit: z.coerce.number().int().min(1).max(2000).default(500),
  to: z.coerce.number().int().positive().optional(),
  denom: z.enum(['native', 'usd']).default('native'),
});

export async function ohlcvRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>('/pairs/:id/ohlcv', async (req, reply) => {
    const resolved = await resolvePair(req.params.id);
    if (resolved === null) throw NotFound('PAIR_NOT_FOUND', `no pair ${req.params.id}`);

    const parsed = Query.safeParse(req.query);
    if (!parsed.success) {
      throw BadRequest('BAD_REQUEST', parsed.error.issues[0]?.message ?? 'invalid query');
    }
    const { interval, limit, to, denom } = parsed.data;

    const candles = await fetchCandles({
      pair: resolved,
      interval: interval as Interval,
      limit,
      ...(to !== undefined ? { to } : {}),
      denom,
    });

    void reply.header('cache-control', 'public, max-age=30');
    return {
      candles,
      interval,
      denom,
      more: candles.length === limit && candles[0]
        ? { to: candles[0].time }
        : null,
    };
  });
}
