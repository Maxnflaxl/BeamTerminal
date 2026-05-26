import type { FastifyInstance } from 'fastify';
import { q } from '../../db.js';

interface HealthRow {
  last_indexed_height: string;
  last_chain_head:     string;
  updated_at:          Date;
}

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async (_req, reply) => {
    const { rows } = await q<HealthRow>(
      'SELECT last_indexed_height, last_chain_head, updated_at FROM cursor WHERE id = 1',
    );
    if (rows.length === 0) {
      void reply.status(503);
      return { status: 'degraded', reason: 'cursor row missing' };
    }
    const row = rows[0]!;
    const lagMs = Date.now() - row.updated_at.getTime();
    const lastIndexed = Number(row.last_indexed_height);
    const chainHead = Number(row.last_chain_head);
    const blocksBehind = chainHead > 0 ? Math.max(0, chainHead - lastIndexed) : null;
    void reply.header('cache-control', 'no-store');
    return {
      status: 'ok',
      last_indexed_height: lastIndexed,
      chain_head:          chainHead || null,
      blocks_behind:       blocksBehind,
      lag_seconds:         Math.round(lagMs / 1000),
    };
  });
}
