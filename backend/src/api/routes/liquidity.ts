import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q } from '../../db.js';
import { BadRequest, NotFound } from '../error.js';
import { resolvePair } from '../repos/pairs.js';

// Pooled-amount time series for a single pool, decomposed by the *source* of the
// reserve changes:
//   - total: actual pooled reserve1/reserve2 over time (from snapshots).
//   - lp:    cumulative net liquidity added by LP deposits/withdrawals.
//   - trades: cumulative reserve change driven by swaps only.
// total ≈ lp + trades (every reserve change comes from one or the other), so the
// three series are a clean decomposition the UI can toggle between.
const Query = z.object({
  source: z.enum(['total', 'lp', 'trades']).default('total'),
  interval: z.enum(['1h', '1d']).default('1d'),
  from: z.coerce.number().int().positive().optional(),
  to: z.coerce.number().int().positive().optional(),
});

const INTERVAL_SQL: Record<'1h' | '1d', string> = {
  '1h': "INTERVAL '1 hour'",
  '1d': "INTERVAL '1 day'",
};

interface SeriesRow {
  ts: string;
  amount1: string | null;
  amount2: string | null;
}

interface PoolMeta {
  aid1: string;
  decimals1: number;
  decimals2: number;
}

export async function liquidityRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>('/pairs/:id/liquidity', async (req, reply) => {
    const resolved = await resolvePair(req.params.id);
    if (resolved === null) throw NotFound('PAIR_NOT_FOUND', `no pair ${req.params.id}`);
    // A combined-pair id sums every tier's series; a single-tier id resolves to
    // a one-element array, preserving the per-pool series.
    const { poolIds, refPoolId } = resolved;

    const parsed = Query.safeParse(req.query);
    if (!parsed.success) {
      throw BadRequest('BAD_REQUEST', parsed.error.issues[0]?.message ?? 'invalid query');
    }
    const { source, interval, from, to } = parsed.data;

    const meta = await q<PoolMeta>(
      `SELECT p.aid1::text AS aid1, a1.decimals AS decimals1, a2.decimals AS decimals2
         FROM pools p
         JOIN assets a1 ON a1.aid = p.aid1
         JOIN assets a2 ON a2.aid = p.aid2
        WHERE p.pool_id = $1`,
      [refPoolId],
    );
    if (!meta.rows[0]) throw NotFound('PAIR_NOT_FOUND', `no pair ${req.params.id}`);
    const { decimals1, decimals2 } = meta.rows[0];

    const iv = INTERVAL_SQL[interval];
    const fromTs = from ? new Date(from * 1000) : null;
    const toTs = to ? new Date(to * 1000) : null;

    let sql: string;
    if (source === 'total') {
      // Last reserve per bucket per pool, then summed across tiers — the real
      // pooled amounts. Snapshots are taken every tick for all active pools, so
      // each pool has a bucket sample and the per-bucket sum is the true total.
      sql = `
        SELECT ts, SUM(amount1)::text AS amount1, SUM(amount2)::text AS amount2
          FROM (
            SELECT EXTRACT(epoch FROM time_bucket(${iv}, ts))::bigint AS ts,
                   pool_id,
                   last(reserve1, ts) AS amount1,
                   last(reserve2, ts) AS amount2
              FROM pool_state_snapshots
             WHERE pool_id = ANY($1)
               AND ($2::timestamptz IS NULL OR ts >= $2)
               AND ($3::timestamptz IS NULL OR ts <= $3)
             GROUP BY time_bucket(${iv}, ts), pool_id
          ) per_pool
         GROUP BY ts
         ORDER BY ts`;
    } else if (source === 'lp') {
      // Cumulative net deposits. Cumulative runs over ALL history; the
      // from/to bound only trims which buckets we return so the running total
      // stays correct at the window's left edge.
      sql = `
        WITH ev AS (
          SELECT time_bucket(${iv}, block_ts) AS bucket,
                 SUM(CASE WHEN kind = 'Deposit' THEN amount1 ELSE -amount1 END) AS d1,
                 SUM(CASE WHEN kind = 'Deposit' THEN amount2 ELSE -amount2 END) AS d2
            FROM lp_events
           WHERE pool_id = ANY($1) AND confirmed = TRUE
           GROUP BY bucket
        ), cum AS (
          SELECT bucket,
                 SUM(d1) OVER (ORDER BY bucket) AS c1,
                 SUM(d2) OVER (ORDER BY bucket) AS c2
            FROM ev
        )
        SELECT EXTRACT(epoch FROM bucket)::bigint AS ts,
               c1::text AS amount1, c2::text AS amount2
          FROM cum
         WHERE ($2::timestamptz IS NULL OR bucket >= $2)
           AND ($3::timestamptz IS NULL OR bucket <= $3)
         ORDER BY bucket`;
    } else {
      // Cumulative reserve change from swaps. aid_in == aid1 means the pool
      // gained aid1 and shed aid2; otherwise the reverse.
      sql = `
        WITH ev AS (
          SELECT time_bucket(${iv}, t.block_ts) AS bucket,
                 SUM(CASE WHEN t.aid_in = p.aid1
                          THEN  COALESCE(t.volume_aid1, 0)
                          ELSE -COALESCE(t.volume_aid1, 0) END) AS d1,
                 SUM(CASE WHEN t.aid_in = p.aid1
                          THEN -COALESCE(t.volume_aid2, 0)
                          ELSE  COALESCE(t.volume_aid2, 0) END) AS d2
            FROM trades t
            JOIN pools p ON p.pool_id = t.pool_id
           WHERE t.pool_id = ANY($1) AND t.confirmed = TRUE
           GROUP BY bucket
        ), cum AS (
          SELECT bucket,
                 SUM(d1) OVER (ORDER BY bucket) AS c1,
                 SUM(d2) OVER (ORDER BY bucket) AS c2
            FROM ev
        )
        SELECT EXTRACT(epoch FROM bucket)::bigint AS ts,
               c1::text AS amount1, c2::text AS amount2
          FROM cum
         WHERE ($2::timestamptz IS NULL OR bucket >= $2)
           AND ($3::timestamptz IS NULL OR bucket <= $3)
         ORDER BY bucket`;
    }

    const { rows } = await q<SeriesRow>(sql, [poolIds, fromTs, toTs]);
    const series = rows.map((r) => ({
      ts: Number(r.ts),
      amount1: r.amount1 ?? '0',
      amount2: r.amount2 ?? '0',
    }));

    void reply.header('cache-control', 'public, max-age=30');
    return { series, decimals1, decimals2 };
  });
}
