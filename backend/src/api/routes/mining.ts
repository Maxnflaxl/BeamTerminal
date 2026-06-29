import type { FastifyInstance } from 'fastify';
import { q } from '../../db.js';
import { POOLS } from '../../mining/pools.js';

// ---------------------------------------------------------------------------
// /api/mining/pools — latest snapshot per pool + current network hashrate
// ---------------------------------------------------------------------------

interface SnapRow {
  pool_id: string;
  ts: Date;
  hashrate: string | null;
  miners: number | null;
  workers: number | null;
  blocks_24h: number | null;
  last_block_height: string | null;
  last_block_ts: Date | null;
  fee: string | null;
  min_payout: string | null;
}

interface HashrateRow {
  hashrate: number | null;
}

export async function miningRoutes(app: FastifyInstance): Promise<void> {
  app.get('/mining/pools', async (_req, reply) => {
    // Latest snapshot per pool.
    const { rows } = await q<SnapRow>(
      `SELECT DISTINCT ON (pool_id)
              pool_id, ts, hashrate::text, miners, workers, blocks_24h,
              last_block_height::text, last_block_ts, fee::text, min_payout::text
         FROM mining_pool_snapshots
        ORDER BY pool_id, ts DESC`,
    );
    const byId = new Map(rows.map((r) => [r.pool_id, r]));

    // Current network hashrate (Sol/s) from recent blocks: Σ difficulty / Δt,
    // matching the Health/Charts diffToHashrate convention.
    const { rows: hr } = await q<HashrateRow>(
      `SELECT (SUM(difficulty)
                / NULLIF(EXTRACT(EPOCH FROM (MAX(block_ts) - MIN(block_ts))), 0))::float8
                AS hashrate
         FROM (SELECT difficulty, block_ts FROM block_metrics
                ORDER BY height DESC LIMIT 60) t
        WHERE difficulty > 0`,
    );
    const networkHashrate = hr[0]?.hashrate ?? null;

    const pools = POOLS.map((p) => {
      const s = byId.get(p.id);
      return {
        id: p.id,
        name: p.name,
        website: p.website,
        payout_scheme: p.payoutScheme,
        hashrate: s?.hashrate != null ? Number(s.hashrate) : null,
        miners: s?.miners ?? null,
        workers: s?.workers ?? null,
        blocks_24h: s?.blocks_24h ?? null,
        last_block_height: s?.last_block_height != null ? Number(s.last_block_height) : null,
        last_block_ts: s?.last_block_ts ? s.last_block_ts.toISOString() : null,
        fee: s?.fee != null ? Number(s.fee) : null,
        min_payout: s?.min_payout != null ? Number(s.min_payout) : null,
        updated_at: s?.ts ? s.ts.toISOString() : null,
      };
    });

    void reply.header('cache-control', 'public, max-age=60');
    return { network_hashrate: networkHashrate, pools };
  });
}
