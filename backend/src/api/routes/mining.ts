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

interface BlockHeightRow {
  max: string | null;
}

interface SparkRow {
  pool_id: string;
  ts: string;
  hashrate: number;
}

interface BlocksLast100Row {
  pool_id: string;
  n: number;
}

interface BlocksQueryRow {
  height: string;
  block_ts: Date;
  mined_by: string | null;
}

// Pool id → display name lookup built from the POOLS registry.
const POOL_NAME_BY_ID = new Map<string, string>(POOLS.map((p) => [p.id, p.name]));

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

    // Network tip height.
    const { rows: bh } = await q<BlockHeightRow>(
      `SELECT MAX(height)::text FROM block_metrics`,
    );
    const blockHeight = bh[0]?.max != null ? Number(bh[0].max) : null;

    // Per-pool hashrate sparkline: last ~30 non-null snapshots, oldest→newest.
    const { rows: sparkRows } = await q<SparkRow>(
      `SELECT pool_id, EXTRACT(epoch FROM ts)::bigint AS ts, hashrate::float8 AS hashrate
         FROM (
           SELECT pool_id, ts, hashrate,
                  ROW_NUMBER() OVER (PARTITION BY pool_id ORDER BY ts DESC) AS rn
             FROM mining_pool_snapshots
            WHERE hashrate IS NOT NULL
         ) ranked
        WHERE rn <= 30
        ORDER BY pool_id, rn DESC`,
    );
    // Group into pool_id → { ts, value }[] (already oldest→newest after ORDER BY rn DESC).
    const sparkByPool = new Map<string, { ts: number; value: number }[]>();
    for (const r of sparkRows) {
      const arr = sparkByPool.get(r.pool_id) ?? [];
      arr.push({ ts: Number(r.ts), value: Number(r.hashrate) });
      sparkByPool.set(r.pool_id, arr);
    }

    // Per-pool blocks in last 100 network heights.
    const { rows: b100Rows } = await q<BlocksLast100Row>(
      `WITH recent AS (SELECT height FROM block_metrics ORDER BY height DESC LIMIT 100)
       SELECT b.pool_id, COUNT(*)::int AS n
         FROM mining_pool_blocks b
         JOIN recent r ON r.height = b.height
        GROUP BY b.pool_id`,
    );
    const blocks100ByPool = new Map<string, number>(b100Rows.map((r) => [r.pool_id, r.n]));

    // Per-pool blocks in last 1000 network heights (used for the distribution donut).
    const { rows: b1000Rows } = await q<BlocksLast100Row>(
      `WITH recent AS (SELECT height FROM block_metrics ORDER BY height DESC LIMIT 1000)
       SELECT b.pool_id, COUNT(*)::int AS n
         FROM mining_pool_blocks b
         JOIN recent r ON r.height = b.height
        GROUP BY b.pool_id`,
    );
    const blocks1000ByPool = new Map<string, number>(b1000Rows.map((r) => [r.pool_id, r.n]));

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
        fee: s?.fee != null ? Number(s.fee) : p.fee,
        min_payout: s?.min_payout != null ? Number(s.min_payout) : null,
        updated_at: s?.ts ? s.ts.toISOString() : null,
        hashrate_series: sparkByPool.get(p.id) ?? [],
        blocks_last_100: blocks100ByPool.get(p.id) ?? 0,
        blocks_last_1000: blocks1000ByPool.get(p.id) ?? 0,
      };
    });

    void reply.header('cache-control', 'public, max-age=60');
    return { network_hashrate: networkHashrate, block_height: blockHeight, pools };
  });

  // -------------------------------------------------------------------------
  // /api/mining/blocks?limit=50 — recent blocks with pool attribution
  // -------------------------------------------------------------------------

  app.get('/mining/blocks', async (req, reply) => {
    const query = req.query as Record<string, string | undefined>;
    const rawLimit = parseInt(query['limit'] ?? '50', 10);
    const limit = Math.min(200, Math.max(1, isNaN(rawLimit) ? 50 : rawLimit));

    const rawOffset = parseInt(query['offset'] ?? '0', 10);
    const offset = Math.max(0, isNaN(rawOffset) ? 0 : rawOffset);

    const { rows } = await q<BlocksQueryRow>(
      `WITH recent AS (
         SELECT height, block_ts FROM block_metrics ORDER BY height DESC LIMIT $1 OFFSET $2
       )
       SELECT r.height::text,
              r.block_ts,
              (SELECT MIN(b.pool_id) FROM mining_pool_blocks b WHERE b.height = r.height) AS mined_by
         FROM recent r
        ORDER BY r.height DESC`,
      [limit, offset],
    );

    const blocks = rows.map((r) => ({
      height: Number(r.height),
      ts: r.block_ts.toISOString(),
      mined_by: r.mined_by != null ? (POOL_NAME_BY_ID.get(r.mined_by) ?? r.mined_by) : null,
    }));

    void reply.header('cache-control', 'public, max-age=30');
    return { blocks };
  });
}
