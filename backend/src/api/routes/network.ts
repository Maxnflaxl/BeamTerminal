import type { FastifyInstance } from 'fastify';
import { getNetworkSnapshot } from '../../services/networkSnapshot.js';

// ---------------------------------------------------------------------------
// /api/network — canonical current network snapshot (hashrate/difficulty/
// block time/tip) plus the last 60 blocks, all from block_metrics. Single
// source of truth shared with /api/mining/pools and the Health page.
// ---------------------------------------------------------------------------

export async function networkRoutes(app: FastifyInstance): Promise<void> {
  app.get('/network', async (_req, reply) => {
    const snapshot = await getNetworkSnapshot();
    void reply.header('cache-control', 'public, max-age=30');
    return snapshot;
  });
}
