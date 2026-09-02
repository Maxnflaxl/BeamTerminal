import type { FastifyInstance } from 'fastify';
import { getBridgeHealth, listBridgeMessages, lookupBridgeTransfer } from '../repos/bridge.js';
import { etherscanEnabled } from '../../services/etherscan.js';
import { queryInt } from '../query.js';

// ---------------------------------------------------------------------------
// /api/bridge/health    — per-bridge liveness + peg backing.
// /api/bridge/messages  — individual transfers, filterable.
//
// Both read Postgres only. The indexer owns every shader call and every
// external API request; nothing here touches wallet-api or Etherscan.
// ---------------------------------------------------------------------------

const VALID_DIRECTIONS = new Set(['beam2eth', 'eth2beam']);
const VALID_STATUSES = new Set([
  'pending', 'relayed', 'failed', 'unsettleable', 'skipped', // beam2eth
  'not_delivered', 'unclaimed', 'complete', // eth2beam
  'unknown', // either
]);

export async function bridgeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/bridge/health', async (_req, reply) => {
    const rows = await getBridgeHealth(etherscanEnabled());
    void reply.header('Cache-Control', 'public, max-age=30');
    // Sum of what every bridge actually holds in escrow. Bridges we can't price
    // are simply absent from the total rather than counted as zero.
    const tvlUsd = rows.reduce<number | null>((acc, r) => {
      if (r.locked_usd === null) return acc;
      return (acc ?? 0) + r.locked_usd;
    }, null);
    return {
      bridges: rows,
      tvl_usd: tvlUsd,
      tvl_priced: rows.filter((r) => r.locked_usd !== null).length,
      // Surfaced so a consumer can tell "no failures" from "we cannot see
      // failures" — without an Etherscan key the beam2eth side is unverifiable.
      settlement_available: etherscanEnabled(),
    };
  });

  // Point lookup for "where is my transfer?". Takes either side's identifier:
  // an Ethereum/Arbitrum tx hash or a Beam kernel id.
  app.get<{ Querystring: { q?: string } }>('/bridge/lookup', async (req, reply) => {
    const query = (req.query.q ?? '').trim();
    if (!query) {
      void reply.code(400);
      return { error: 'q is required' };
    }
    const result = await lookupBridgeTransfer(query);
    // Short cache: a pending transfer's state is exactly what the caller is
    // watching for, so don't serve a stale answer for long.
    void reply.header('Cache-Control', 'public, max-age=10');
    return result;
  });

  app.get<{
    Querystring: {
      bridge?: string; direction?: string; status?: string;
      sort?: string; dir?: string;
      limit?: string; offset?: string;
    };
  }>('/bridge/messages', async (req, reply) => {
    const limit = queryInt(req.query.limit, { default: 50, min: 1, max: 500 });
    const offset = queryInt(req.query.offset, { default: 0, min: 0 });
    const direction = req.query.direction && VALID_DIRECTIONS.has(req.query.direction)
      ? req.query.direction : undefined;
    const status = req.query.status && VALID_STATUSES.has(req.query.status)
      ? req.query.status : undefined;

    const { rows, total } = await listBridgeMessages({
      bridge: req.query.bridge,
      direction,
      status,
      sort: req.query.sort,
      dir: req.query.dir,
      limit,
      offset,
    });
    void reply.header('Cache-Control', 'public, max-age=30');
    return {
      messages: rows,
      total,
      limit,
      offset,
      sort: req.query.sort ?? 'age',
      dir: req.query.dir === 'asc' ? 'asc' : 'desc',
    };
  });
}
