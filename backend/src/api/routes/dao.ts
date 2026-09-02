import type { FastifyInstance } from 'fastify';
import { loadDaoTreasury, loadDaoTreasuryAsset } from '../repos/daoTreasury.js';
import { loadDaoRevenue } from '../repos/daoRevenue.js';
import { loadDaoGovernance, loadDaoProposal } from '../repos/daoGovernance.js';
import { loadDaoOverview } from '../repos/daoOverview.js';
import { queryInt } from '../query.js';

// ---------------------------------------------------------------------------
// /api/dao/* — DAO explorer surface (DaoVault treasury/revenue, DaoVote
// governance). Reads Postgres only, like every other /api route.
// ---------------------------------------------------------------------------
export async function daoRoutes(app: FastifyInstance): Promise<void> {
  app.get('/dao/overview', async (_req, reply) => {
    void reply.header('cache-control', 'public, max-age=60');
    return loadDaoOverview();
  });

  app.get('/dao/treasury', async (_req, reply) => {
    void reply.header('cache-control', 'public, max-age=60');
    return loadDaoTreasury();
  });

  app.get('/dao/treasury/asset/:aid', async (req, reply) => {
    const aid = Number((req.params as { aid: string }).aid);
    if (!Number.isInteger(aid) || aid < 0) {
      void reply.code(400);
      return { error: { code: 'BAD_REQUEST', message: 'invalid asset id' } };
    }
    const query = req.query as { limit?: string };
    const limit = queryInt(query.limit, { default: 100, min: 1, max: 500 });
    void reply.header('cache-control', 'public, max-age=60');
    return loadDaoTreasuryAsset(aid, limit);
  });

  app.get('/dao/revenue', async (_req, reply) => {
    void reply.header('cache-control', 'public, max-age=300');
    return loadDaoRevenue();
  });

  app.get('/dao/governance', async (_req, reply) => {
    void reply.header('cache-control', 'public, max-age=60');
    return loadDaoGovernance();
  });

  app.get('/dao/governance/proposals/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id) || id < 0) {
      void reply.code(400);
      return { error: { code: 'BAD_REQUEST', message: 'invalid proposal id' } };
    }
    const query = req.query as { offset?: string; limit?: string };
    const offset = queryInt(query.offset, { default: 0, min: 0 });
    const limit = queryInt(query.limit, { default: 25, min: 1, max: 200 });
    void reply.header('cache-control', 'public, max-age=60');
    const result = await loadDaoProposal(id, offset, limit);
    if (!result.proposal) {
      void reply.code(404);
      return { error: { code: 'NOT_FOUND', message: 'proposal not found' } };
    }
    return result;
  });
}
