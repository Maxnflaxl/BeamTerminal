import type { FastifyInstance } from 'fastify';
import { q } from '../../db.js';

interface HealthRow {
  last_indexed_height: string;
  updated_at: Date;
}

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async (_req, reply) => {
    const { rows } = await q<HealthRow>(
      'SELECT last_indexed_height, updated_at FROM cursor WHERE id = 1',
    );
    if (rows.length === 0) {
      void reply.status(503);
      return { status: 'degraded', reason: 'cursor row missing' };
    }
    const row = rows[0]!;
    const lagMs = Date.now() - row.updated_at.getTime();
    void reply.header('cache-control', 'no-store');
    return {
      status: 'ok',
      last_indexed_height: Number(row.last_indexed_height),
      lag_seconds: Math.round(lagMs / 1000),
    };
  });
}
