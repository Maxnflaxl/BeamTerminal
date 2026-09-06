import type { FastifyInstance } from 'fastify';
import { loadOracleState } from '../repos/oracle.js';

// ---------------------------------------------------------------------------
// /api/oracle — current Oracle2 feed state. Reads Postgres only; the indexer
// owns the shader call that fills the row (services/oracle2.ts).
// ---------------------------------------------------------------------------
export async function oracleRoutes(app: FastifyInstance): Promise<void> {
  app.get('/oracle', async (_req, reply) => {
    const state = await loadOracleState();
    if (!state) {
      void reply.code(503);
      return { error: { code: 'UNAVAILABLE', message: 'oracle state not yet indexed' } };
    }
    void reply.header('Cache-Control', 'public, max-age=30');
    return state;
  });
}
