import type { FastifyInstance } from 'fastify';
import { API_DOCS_HTML } from '../apiDocs.generated.js';

// Human-readable API reference at /api (and /api/). Registered WITHOUT a prefix
// so both the slash and no-slash forms are explicit (Fastify here does not set
// ignoreTrailingSlash). Static HTML — no DB, no external calls.
export async function apiDocsRoutes(app: FastifyInstance): Promise<void> {
  const handler = async (_req: unknown, reply: any) => {
    void reply.header('content-type', 'text/html; charset=utf-8');
    void reply.header('cache-control', 'public, max-age=300');
    return API_DOCS_HTML;
  };
  app.get('/api', handler);
  app.get('/api/', handler);
}
