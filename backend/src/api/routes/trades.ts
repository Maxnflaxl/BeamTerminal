import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q } from '../../db.js';
import { BadRequest, NotFound } from '../error.js';
import { resolvePairId } from '../repos/pairs.js';

const Query = z.object({
  kind: z.enum(['Trade', 'lp']).default('Trade'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.coerce.number().int().positive().optional(),
  include_unconfirmed: z.coerce.boolean().default(true),
});

interface TradeRow {
  trade_id: string;
  height: string;
  block_ts: Date;
  aid_in: string;
  aid_out: string;
  amount_in: string;
  amount_out: string;
  volume_aid1: string | null;
  volume_aid2: string | null;
  price_native: string | null;
  confirmed: boolean;
  aid1: string;
  decimals1: number;
}

interface LpRow {
  event_id: string;
  height: string;
  block_ts: Date;
  kind: 'Deposit' | 'Withdraw';
  amount1: string;
  amount2: string;
  amount_ctl: string;
  confirmed: boolean;
}

async function readBeamUsd(): Promise<number | null> {
  const { rows } = await q<{ beam_usd: string }>(
    'SELECT beam_usd::text AS beam_usd FROM oracle_snapshots ORDER BY ts DESC LIMIT 1',
  );
  return rows[0] ? Number(rows[0].beam_usd) : null;
}

async function readLastIndexedHeight(): Promise<number> {
  const { rows } = await q<{ last_indexed_height: string }>(
    'SELECT last_indexed_height::text AS last_indexed_height FROM cursor WHERE id = 1',
  );
  return rows[0] ? Number(rows[0].last_indexed_height) : 0;
}

export async function tradesRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>('/pairs/:id/trades', async (req, reply) => {
    const poolId = await resolvePairId(req.params.id);
    if (poolId === null) throw NotFound('PAIR_NOT_FOUND', `no pair ${req.params.id}`);

    const parsed = Query.safeParse(req.query);
    if (!parsed.success) {
      throw BadRequest('BAD_REQUEST', parsed.error.issues[0]?.message ?? 'invalid query');
    }
    const { kind, limit, before, include_unconfirmed } = parsed.data;

    const beforeTs = before ? new Date(before * 1000) : new Date();
    const confirmedFilter = include_unconfirmed ? '' : 'AND t.confirmed = TRUE';
    const lastHeight = await readLastIndexedHeight();
    const beamUsd = await readBeamUsd();

    if (kind === 'lp') {
      const { rows } = await q<LpRow>(
        `SELECT event_id::text, height::text, block_ts, kind,
                amount1::text, amount2::text, amount_ctl::text, confirmed
           FROM lp_events t
          WHERE t.pool_id = $1
            AND t.block_ts < $2
            ${confirmedFilter}
          ORDER BY t.block_ts DESC
          LIMIT $3`,
        [poolId, beforeTs, limit],
      );
      const trades = rows.map((r) => ({
        event_id: Number(r.event_id),
        timestamp: Math.floor(r.block_ts.getTime() / 1000),
        height: Number(r.height),
        kind: r.kind,
        amount1: r.amount1,
        amount2: r.amount2,
        amount_ctl: r.amount_ctl,
        confirmed: r.confirmed,
      }));
      void reply.header('cache-control', 'public, max-age=15');
      return { trades, before: trades.at(-1)?.timestamp ?? null };
    }

    const { rows } = await q<TradeRow>(
      `SELECT t.trade_id::text, t.height::text, t.block_ts,
              t.aid_in::text, t.aid_out::text,
              t.amount_in::text, t.amount_out::text,
              t.volume_aid1::text, t.volume_aid2::text,
              t.price_native::text,
              t.confirmed,
              p.aid1::text, a1.decimals AS decimals1
         FROM trades t
         JOIN pools p   ON p.pool_id = t.pool_id
         JOIN assets a1 ON a1.aid    = p.aid1
        WHERE t.pool_id = $1
          AND t.block_ts < $2
          ${confirmedFilter}
        ORDER BY t.block_ts DESC
        LIMIT $3`,
      [poolId, beforeTs, limit],
    );

    const trades = rows.map((r) => {
      const aid1 = Number(r.aid1);
      const aidIn = Number(r.aid_in);
      const priceNative = r.price_native ? Number(r.price_native) : null;
      const side: 'buy' | 'sell' = aidIn === aid1 ? 'buy' : 'sell';
      const volumeAid1Human = r.volume_aid1
        ? Number(r.volume_aid1) / 10 ** r.decimals1
        : null;
      const priceUsd =
        beamUsd !== null && priceNative !== null && aid1 === 0
          ? priceNative > 0
            ? beamUsd / priceNative
            : null
          : null;
      const valueUsd =
        beamUsd !== null && volumeAid1Human !== null && aid1 === 0
          ? +(volumeAid1Human * beamUsd).toFixed(4)
          : null;

      return {
        trade_id: Number(r.trade_id),
        timestamp: Math.floor(r.block_ts.getTime() / 1000),
        height: Number(r.height),
        aid_in: aidIn,
        aid_out: Number(r.aid_out),
        amount_in: r.amount_in,
        amount_out: r.amount_out,
        side,
        price_native: priceNative,
        price_usd: priceUsd,
        value_usd: valueUsd,
        confirmed: r.confirmed,
        confirmations: r.confirmed ? 80 : Math.max(0, lastHeight - Number(r.height)),
      };
    });

    void reply.header('cache-control', 'public, max-age=15');
    return { trades, before: trades.at(-1)?.timestamp ?? null };
  });
}
