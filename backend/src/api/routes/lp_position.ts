import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q } from '../../db.js';
import { BadRequest, NotFound } from '../error.js';
import { getBlock } from '../../explorer.js';
import { logger } from '../../logger.js';
import { loadHistoricalPrices } from '../repos/historical_price.js';

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

// ---------------------------------------------------------------------------
// Multi-operation lookup: a list of heights and/or kernel ids → every indexed
// add/remove liquidity op, grouped by pool, each enriched with the historical
// BEAM/USD price of both assets at the op's height.
// ---------------------------------------------------------------------------

const KERNEL_RE = /^[0-9a-fA-F]{64}$/;
const HEIGHT_RE = /^\d+$/;
const MAX_REFS = 50;

interface LpEvent {
  kind: 'Deposit' | 'Withdraw';
  amount1: string;
  amount2: string;
  amount_ctl: string;
  height: number;
  ts: number;
  confirmed: boolean;
  // Per whole unit, at this event's height (null when no BEAM route).
  beam_per_aid1: number | null;
  beam_per_aid2: number | null;
  usd_per_aid1: number | null;
  usd_per_aid2: number | null;
}

interface PoolEvents {
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
  events: LpEvent[];
  // Present-time per-whole-unit prices, for valuing the still-in-pool remainder.
  current_beam_per_aid1: number | null;
  current_beam_per_aid2: number | null;
  current_usd_per_aid1: number | null;
  current_usd_per_aid2: number | null;
}

interface EventRow extends DepositRow {
  event_kind: 'Deposit' | 'Withdraw';
}

// A height comfortably beyond the chain tip; "nearest snapshot at/before" then
// resolves to the latest row, giving present-time prices from the same helper.
const NOW_HEIGHT = 2_000_000_000;

function parseRefs(raw: string): { heights: number[]; kernels: string[]; invalid: string[] } {
  const heights: number[] = [];
  const kernels: string[] = [];
  const invalid: string[] = [];
  const tokens = raw.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);
  for (const tok of tokens.slice(0, MAX_REFS)) {
    if (KERNEL_RE.test(tok)) kernels.push(tok.toLowerCase());
    else if (HEIGHT_RE.test(tok)) heights.push(Number(tok));
    else invalid.push(tok);
  }
  // Surface refs beyond the cap instead of silently dropping them (which would
  // produce a wrong aggregation with no signal to the user).
  invalid.push(...tokens.slice(MAX_REFS));
  return { heights, kernels, invalid };
}

/** Every add/remove liquidity op at the given heights, grouped by pool. */
async function eventsAtHeights(heights: number[]): Promise<PoolEvents[]> {
  if (heights.length === 0) return [];
  const { rows } = await q<EventRow>(
    `SELECT
       e.kind                               AS event_kind,
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
     WHERE e.height = ANY($1::bigint[])
     ORDER BY e.height ASC, e.block_ts ASC`,
    [heights],
  );

  // Batch all historical BEAM/USD lookups: both sides of every event at its
  // height, plus both sides of every distinct pool at NOW_HEIGHT (present).
  const priceReqs: Array<{ aid: number; height: number }> = [];
  const seenPoolAids = new Set<number>();
  for (const r of rows) {
    const h = Number(r.height);
    priceReqs.push({ aid: Number(r.aid1), height: h }, { aid: Number(r.aid2), height: h });
    if (!seenPoolAids.has(Number(r.aid_ctl))) {
      seenPoolAids.add(Number(r.aid_ctl));
      priceReqs.push(
        { aid: Number(r.aid1), height: NOW_HEIGHT },
        { aid: Number(r.aid2), height: NOW_HEIGHT },
      );
    }
  }
  const prices = await loadHistoricalPrices(priceReqs);

  const byPool = new Map<number, PoolEvents>();
  for (const r of rows) {
    const aidCtl = Number(r.aid_ctl);
    let pe = byPool.get(aidCtl);
    if (!pe) {
      const cur1 = prices.get(`${Number(r.aid1)}:${NOW_HEIGHT}`);
      const cur2 = prices.get(`${Number(r.aid2)}:${NOW_HEIGHT}`);
      pe = {
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
        events: [],
        current_beam_per_aid1: cur1?.beamPerWhole ?? null,
        current_beam_per_aid2: cur2?.beamPerWhole ?? null,
        current_usd_per_aid1: cur1?.usdPerWhole ?? null,
        current_usd_per_aid2: cur2?.usdPerWhole ?? null,
      };
      byPool.set(aidCtl, pe);
    }
    const h = Number(r.height);
    const p1 = prices.get(`${Number(r.aid1)}:${h}`);
    const p2 = prices.get(`${Number(r.aid2)}:${h}`);
    pe.events.push({
      kind: r.event_kind,
      amount1: r.amount1,
      amount2: r.amount2,
      amount_ctl: r.amount_ctl,
      height: h,
      ts: Number(r.ts),
      confirmed: r.confirmed,
      beam_per_aid1: p1?.beamPerWhole ?? null,
      beam_per_aid2: p2?.beamPerWhole ?? null,
      usd_per_aid1: p1?.usdPerWhole ?? null,
      usd_per_aid2: p2?.usdPerWhole ?? null,
    });
  }
  // Busiest pool first, then by LP-token id for stability.
  return [...byPool.values()].sort(
    (a, b) => b.events.length - a.events.length || a.lp_token - b.lp_token,
  );
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

  // Multi-ref lookup: `?refs=<heights and/or kernel ids, comma/space-separated>`.
  // Resolves every add/remove liquidity op across the refs, grouped by pool,
  // with each op's BEAM/USD historical valuation. Kernel ids are resolved to
  // heights via the explorer (the only explorer touch); `unresolved` lists any
  // refs that didn't map to a block.
  app.get('/lp-position/events', async (req, reply) => {
    const parsed = z.object({ refs: z.string().min(1) }).safeParse(req.query);
    if (!parsed.success) {
      throw BadRequest('BAD_REQUEST', 'refs is required (heights and/or kernel ids)');
    }
    const { heights, kernels, invalid } = parseRefs(parsed.data.refs);
    if (heights.length === 0 && kernels.length === 0) {
      throw BadRequest('BAD_REQUEST', 'provide at least one block height or kernel id');
    }

    const allHeights = new Set<number>(heights);
    const unresolved: string[] = [...invalid];
    const settled = await Promise.allSettled(kernels.map((k) => getBlock({ kernel: k })));
    settled.forEach((res, i) => {
      if (res.status === 'fulfilled' && res.value.found && Number.isFinite(res.value.height)) {
        allHeights.add(res.value.height);
      } else {
        if (res.status === 'rejected') {
          logger.warn({ err: res.reason, kernel: kernels[i] }, 'lp-position events: kernel resolve failed');
        }
        unresolved.push(kernels[i]!);
      }
    });

    if (allHeights.size === 0) {
      throw NotFound('NO_REFS_RESOLVED', 'none of the provided references resolved to a block');
    }

    const pools = await eventsAtHeights([...allHeights]);
    void reply.header('cache-control', 'public, max-age=30');
    return { pools, unresolved };
  });
}
