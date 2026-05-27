import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q } from '../../db.js';
import { BadRequest, NotFound } from '../error.js';
import { getBlock } from '../../explorer.js';
import { logger } from '../../logger.js';

// Fee tiers by `kind` (mirrors KIND_LABEL in pairs.ts + the contract's bps).
const KIND_LABEL: Record<number, string> = { 0: 'Low', 1: 'Medium', 2: 'High' };
const KIND_PCT: Record<number, number> = { 0: 0.05, 1: 0.3, 2: 1.0 };

interface DepositInfo {
  /** Public pair reference usable with GET /api/pairs/:id (the LP-token aid). */
  lp_token: number;
  pair_id: number;
  aid1: number;
  aid2: number;
  aid_ctl: number;
  symbol1: string | null;
  symbol2: string | null;
  decimals1: number;
  decimals2: number;
  kind: number;
  kind_label: string;
  fee_pct: number;
  /** Magnitudes in groths (decimal strings — may exceed 2^53). */
  amount1: string;
  amount2: string;
  amount_ctl: string;
  height: number;
  /** Unix seconds of the deposit block. */
  ts: number;
  confirmed: boolean;
}

interface DepositRow {
  height: string;
  ts: string;
  amount1: string;
  amount2: string;
  amount_ctl: string;
  confirmed: boolean;
  pair_id: string;
  aid1: string;
  aid2: string;
  aid_ctl: string;
  kind: number;
  symbol1: string | null;
  symbol2: string | null;
  decimals1: number;
  decimals2: number;
}

function toDepositInfo(r: DepositRow): DepositInfo {
  const aidCtl = Number(r.aid_ctl);
  return {
    lp_token: aidCtl,
    pair_id: Number(r.pair_id),
    aid1: Number(r.aid1),
    aid2: Number(r.aid2),
    aid_ctl: aidCtl,
    symbol1: r.symbol1,
    symbol2: r.symbol2,
    decimals1: r.decimals1,
    decimals2: r.decimals2,
    kind: r.kind,
    kind_label: KIND_LABEL[r.kind] ?? 'Unknown',
    fee_pct: KIND_PCT[r.kind] ?? 0,
    amount1: r.amount1,
    amount2: r.amount2,
    amount_ctl: r.amount_ctl,
    height: Number(r.height),
    ts: Number(r.ts),
    confirmed: r.confirmed,
  };
}

/** All Liquidity-Add deposits indexed at a given block height. */
async function depositsAtHeight(height: number): Promise<DepositInfo[]> {
  const { rows } = await q<DepositRow>(
    `SELECT
       e.height::text                       AS height,
       extract(epoch FROM e.block_ts)::bigint::text AS ts,
       e.amount1::text                      AS amount1,
       e.amount2::text                      AS amount2,
       e.amount_ctl::text                   AS amount_ctl,
       e.confirmed                          AS confirmed,
       p.pool_id::text                      AS pair_id,
       p.aid1::text                         AS aid1,
       p.aid2::text                         AS aid2,
       p.aid_ctl::text                      AS aid_ctl,
       p.kind                               AS kind,
       a1.short_name                        AS symbol1,
       a2.short_name                        AS symbol2,
       a1.decimals                          AS decimals1,
       a2.decimals                          AS decimals2
     FROM lp_events e
     JOIN pools  p  ON p.pool_id = e.pool_id
     JOIN assets a1 ON a1.aid = p.aid1
     JOIN assets a2 ON a2.aid = p.aid2
     WHERE e.height = $1 AND e.kind = 'Deposit'
     ORDER BY e.block_ts ASC`,
    [height],
  );
  return rows.map(toDepositInfo);
}

const Query = z
  .object({
    kernel: z.string().regex(/^[0-9a-fA-F]{64}$/, 'kernel must be 64 hex chars').optional(),
    height: z.coerce.number().int().positive().optional(),
  })
  .refine((v) => (v.kernel === undefined) !== (v.height === undefined), {
    message: 'provide exactly one of `kernel` or `height`',
  });

export async function lpPositionRoutes(app: FastifyInstance): Promise<void> {
  // Look up a Liquidity-Add deposit by block height (DB only) or kernel id
  // (resolved to a height via one explorer /block call — the sole place the
  // API touches the explorer; everything else reads Postgres). Returns one
  // DepositInfo, or `{ candidates: [...] }` when a height has several deposits.
  app.get('/lp-position/deposit', async (req, reply) => {
    const parsed = Query.safeParse(req.query);
    if (!parsed.success) {
      throw BadRequest('BAD_REQUEST', parsed.error.issues[0]?.message ?? 'invalid query');
    }
    const { kernel, height } = parsed.data;

    let targetHeight: number;
    if (kernel !== undefined) {
      let block;
      try {
        block = await getBlock({ kernel });
      } catch (err) {
        logger.warn({ err, kernel }, 'lp-position kernel lookup: explorer error');
        throw BadRequest('EXPLORER_UNAVAILABLE', 'could not reach the explorer to resolve the kernel id');
      }
      if (!block.found || !Number.isFinite(block.height)) {
        throw NotFound('KERNEL_NOT_FOUND', 'no block found for that kernel id');
      }
      targetHeight = block.height;
    } else {
      targetHeight = height!;
    }

    const deposits = await depositsAtHeight(targetHeight);
    if (deposits.length === 0) {
      throw NotFound(
        'DEPOSIT_NOT_FOUND',
        `no indexed "Liquidity Add" at height ${targetHeight}`,
      );
    }

    void reply.header('cache-control', 'public, max-age=30');
    if (deposits.length === 1) return deposits[0];
    return { candidates: deposits };
  });
}
