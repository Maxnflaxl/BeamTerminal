import type { FastifyInstance } from 'fastify';
import { getBridgeHealth, listBridgeMessages } from '../repos/bridge.js';
import { etherscanEnabled } from '../../services/etherscan.js';

// ---------------------------------------------------------------------------
// /api/bridge/health    — per-bridge liveness + peg backing.
// /api/bridge/messages  — individual transfers, filterable.
//
// Both read Postgres only. The indexer owns every shader call and every
// external API request; nothing here touches wallet-api or Etherscan.
// ---------------------------------------------------------------------------

const VALID_DIRECTIONS = new Set(['beam2eth', 'eth2beam']);
const VALID_STATUSES = new Set([
  'pending', 'relayed', 'failed', // beam2eth
  'not_delivered', 'unclaimed', 'complete', // eth2beam
  'unknown', // either
]);

export async function bridgeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/bridge/health', async (_req, reply) => {
    const rows = await getBridgeHealth(etherscanEnabled());
    void reply.header('Cache-Control', 'public, max-age=30');
    return {
      bridges: rows,
      // Surfaced so a consumer can tell "no failures" from "we cannot see
      // failures" — without an Etherscan key the beam2eth side is unverifiable.
      settlement_available: etherscanEnabled(),
    };
  });

  app.get<{
    Querystring: {
      bridge?: string; direction?: string; status?: string;
      limit?: string; offset?: string;
    };
  }>('/bridge/messages', async (req, reply) => {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 500);
    const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);
    const direction = req.query.direction && VALID_DIRECTIONS.has(req.query.direction)
      ? req.query.direction : undefined;
    const status = req.query.status && VALID_STATUSES.has(req.query.status)
      ? req.query.status : undefined;

    const { rows, total } = await listBridgeMessages({
      bridge: req.query.bridge,
      direction,
      status,
      limit,
      offset,
    });
    void reply.header('Cache-Control', 'public, max-age=30');
    return { messages: rows, total, limit, offset };
  });
}
