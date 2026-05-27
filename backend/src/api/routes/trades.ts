import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q } from '../../db.js';
import { BadRequest, NotFound } from '../error.js';
import { resolvePair } from '../repos/pairs.js';

const Query = z.object({
  kind: z.enum(['Trade', 'lp']).default('Trade'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  // Cursor mode (newest-first "load older"). Mutually exclusive with `offset`.
  before: z.coerce.number().int().positive().optional(),
  // Offset mode (numbered pagination). When present, takes precedence over
  // `before`. `count=true` additionally returns the pool's total row count so
  // the UI can render "Showing X to Y of N entries".
  offset: z.coerce.number().int().min(0).optional(),
  count: z.coerce.boolean().default(false),
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
  ctl_after: string | null;
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
    const resolved = await resolvePair(req.params.id);
    if (resolved === null) throw NotFound('PAIR_NOT_FOUND', `no pair ${req.params.id}`);
    // Combined (pair-form) ids fan out across every tier; single-tier ids
    // resolve to a one-element array, preserving the per-pool behaviour.
    const poolIds = resolved.poolIds;

    const parsed = Query.safeParse(req.query);
    if (!parsed.success) {
      throw BadRequest('BAD_REQUEST', parsed.error.issues[0]?.message ?? 'invalid query');
    }
    const {
      kind, limit, before, offset, count, include_unconfirmed,
    } = parsed.data;

    const useOffset = offset !== undefined;
    const beforeTs = before ? new Date(before * 1000) : new Date();
    const confirmedFilter = include_unconfirmed ? '' : 'AND t.confirmed = TRUE';
    const lastHeight = await readLastIndexedHeight();
    const beamUsd = await readBeamUsd();

    if (kind === 'lp') {
      // ctl_after: LP token supply at the first snapshot taken at/after the
      // event's height — i.e. the pool size *after* this deposit/withdraw.
      // liquidity_pct expresses the event as a (signed) share of that pool.
      const ctlAfterCol = `(SELECT s.ctl_supply::text FROM pool_state_snapshots s
                              WHERE s.pool_id = t.pool_id AND s.height >= t.height
                              ORDER BY s.height LIMIT 1) AS ctl_after`;
      const { rows } = useOffset
        ? await q<LpRow>(
          `SELECT event_id::text, height::text, block_ts, kind,
                  amount1::text, amount2::text, amount_ctl::text, confirmed,
                  ${ctlAfterCol}
             FROM lp_events t
            WHERE t.pool_id = ANY($1)
              ${confirmedFilter}
            ORDER BY t.block_ts DESC, t.event_id DESC
            LIMIT $2 OFFSET $3`,
          [poolIds, limit, offset],
        )
        : await q<LpRow>(
          `SELECT event_id::text, height::text, block_ts, kind,
                  amount1::text, amount2::text, amount_ctl::text, confirmed,
                  ${ctlAfterCol}
             FROM lp_events t
            WHERE t.pool_id = ANY($1)
              AND t.block_ts < $2
              ${confirmedFilter}
            ORDER BY t.block_ts DESC, t.event_id DESC
            LIMIT $3`,
          [poolIds, beforeTs, limit],
        );
      const trades = rows.map((r) => {
        const ctlAfter = r.ctl_after ? Number(r.ctl_after) : null;
        const share = ctlAfter && ctlAfter > 0
          ? (Number(r.amount_ctl) / ctlAfter) * 100
          : null;
        const liquidityPct = share === null
          ? null
          : r.kind === 'Withdraw' ? -share : share;
        return {
          event_id: Number(r.event_id),
          timestamp: Math.floor(r.block_ts.getTime() / 1000),
          height: Number(r.height),
          kind: r.kind,
          amount1: r.amount1,
          amount2: r.amount2,
          amount_ctl: r.amount_ctl,
          liquidity_pct: liquidityPct,
          confirmed: r.confirmed,
        };
      });
      const total = count
        ? await countRows('lp_events', poolIds, include_unconfirmed)
        : null;
      void reply.header('cache-control', 'public, max-age=15');
      return {
        trades,
        before: useOffset ? null : trades.at(-1)?.timestamp ?? null,
        offset: useOffset ? offset : null,
        limit,
        total,
      };
    }

    const { rows } = useOffset
      ? await q<TradeRow>(
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
          WHERE t.pool_id = ANY($1)
            ${confirmedFilter}
          ORDER BY t.block_ts DESC, t.trade_id DESC
          LIMIT $2 OFFSET $3`,
        [poolIds, limit, offset],
      )
      : await q<TradeRow>(
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
          WHERE t.pool_id = ANY($1)
            AND t.block_ts < $2
            ${confirmedFilter}
          ORDER BY t.block_ts DESC, t.trade_id DESC
          LIMIT $3`,
        [poolIds, beforeTs, limit],
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

    const total = count
      ? await countRows('trades', poolIds, include_unconfirmed)
      : null;
    void reply.header('cache-control', 'public, max-age=15');
    return {
      trades,
      before: useOffset ? null : trades.at(-1)?.timestamp ?? null,
      offset: useOffset ? offset : null,
      limit,
      total,
    };
  });
}

// Total row count for a pool, honouring the unconfirmed filter so the
// "of N entries" denominator matches the rows actually paged through.
async function countRows(
  table: 'trades' | 'lp_events',
  poolIds: number[],
  includeUnconfirmed: boolean,
): Promise<number> {
  const filter = includeUnconfirmed ? '' : 'AND confirmed = TRUE';
  const { rows } = await q<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${table} WHERE pool_id = ANY($1) ${filter}`,
    [poolIds],
  );
  return rows[0] ? Number(rows[0].n) : 0;
}
