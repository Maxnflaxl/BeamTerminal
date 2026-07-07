import type { FastifyInstance } from 'fastify';
import { loadBansActions } from '../repos/contractActivity.js';

// ---------------------------------------------------------------------------
// /api/bans/actions — full BANS action history (Register / Set Price / Extend /
// Set Owner / Remove Price / Buy / Create), oldest→newest, from
// contract_call_events. Powers the explorer timeline chart + activity list.
// ---------------------------------------------------------------------------
export async function bansRoutes(app: FastifyInstance): Promise<void> {
  app.get('/bans/actions', async (_req, reply) => {
    const result = await loadBansActions();
    void reply.header('cache-control', 'public, max-age=60');
    return result;
  });
}
