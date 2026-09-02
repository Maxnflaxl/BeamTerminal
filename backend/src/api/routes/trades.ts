import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q } from '../../db.js';
import { BadRequest, NotFound } from '../error.js';
import { resolvePair } from '../repos/pairs.js';
import { loadUsdTable } from '../repos/usd.js';
import { queryBool } from '../query.js';

const Query = z.object({
  kind: z.enum(['Trade', 'lp']).default('Trade'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  // Cursor mode (newest-first "load older"). Mutually exclusive with `offset`.
  before: z.coerce.number().int().positive().optional(),
  // Row id (trade_id / event_id) of the last row seen, paired with `before`.
  // Several trades share one block timestamp, so `before` alone would skip
  // the rest of the block the previous page ended in.
  before_id: z.coerce.number().int().positive().optional(),
  // Offset mode (numbered pagination). When present, takes precedence over
  // `before`. `count=true` additionally returns the pool's total row count so
  // the UI can render "Showing X to Y of N entries".
  offset: z.coerce.number().int().min(0).optional(),
  count: queryBool(false),
  include_unconfirmed: queryBool(true),
});

interface TradeRow {
  trade_id: string;
  height: string;
  block_ts: Date;
  aid_in: string;
  aid_out: string;
  amount_in: string;
  amount_out: string;
  volume_aid1: string | null;
  volume_aid2: string | null;
  price_native: string | null;
  confirmed: boolean;
  aid1: string;
  decimals1: number;
}

interface LpRow {
  event_id: string;
  height: string;
  block_ts: Date;
  kind: 'Deposit' | 'Withdraw';
  amount1: string;
  amount2: string;
  amount_ctl: string;
  confirmed: boolean;
  ctl_after: string | null;
}

async function readBeamUsd(): Promise<number | null> {
  const { rows } = await q<{ beam_usd: string }>(
    'SELECT beam_usd::text AS beam_usd FROM oracle_snapshots ORDER BY ts DESC LIMIT 1',
  );
  return rows[0] ? Number(rows[0].beam_usd) : null;
}

async function readLastIndexedHeight(): Promise<number> {
  const { rows } = await q<{ last_indexed_height: string }>(
    'SELECT last_indexed_height::text AS last_indexed_height FROM cursor WHERE id = 1',
  );
  return rows[0] ? Number(rows[0].last_indexed_height) : 0;
}

export async function tradesRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>('/pairs/:id/trades', async (req, reply) => {
    const resolved = await resolvePair(req.params.id);
    if (resolved === null) throw NotFound('PAIR_NOT_FOUND', `no pair ${req.params.id}`);
    // Combined (pair-form) ids fan out across every tier; single-tier ids
    // resolve to a one-element array, preserving the per-pool behaviour.
    const poolIds = resolved.poolIds;

    const parsed = Query.safeParse(req.query);
    if (!parsed.success) {
      throw BadRequest('BAD_REQUEST', parsed.error.issues[0]?.message ?? 'invalid query');
    }
    const {
      kind, limit, before, before_id, offset, count, include_unconfirmed,
    } = parsed.data;

    const useOffset = offset !== undefined;
    const beforeTs = before ? new Date(before * 1000) : new Date();
    const confirmedFilter = include_unconfirmed ? '' : 'AND t.confirmed = TRUE';
    // Keyset cursor: `(block_ts, id) < (ts, id)` when the caller passed both
    // halves, plain `block_ts < ts` for `before`-only callers.
    const cursorParams: Array<Date | number> =
      before !== undefined && before_id !== undefined ? [beforeTs, before_id] : [beforeTs];
    const cursorWhere = (idCol: string): string => (
      cursorParams.length === 2
        ? `(t.block_ts, t.${idCol}) < ($2, $3)`
        : 't.block_ts < $2'
    );
    const cursorLimitParam = `$${2 + cursorParams.length}`;

    if (kind === 'lp') {
      // ctl_after: LP token supply at the first snapshot taken at/after the
      // event's height — i.e. the pool size *after* this deposit/withdraw.
      // liquidity_pct expresses the event as a (signed) share of the pool it
      // moved: the supply after a deposit, before a withdraw. Dividing a
      // near-total withdraw by the dust it leaves behind yields nonsense.
      const ctlAfterCol = `(SELECT s.ctl_supply::text FROM pool_state_snapshots s
                              WHERE s.pool_id = t.pool_id AND s.height >= t.height
                              ORDER BY s.height LIMIT 1) AS ctl_after`;
      const { rows } = useOffset
        ? await q<LpRow>(
          `SELECT event_id::text, height::text, block_ts, kind,
                  amount1::text, amount2::text, amount_ctl::text, confirmed,
                  ${ctlAfterCol}
             FROM lp_events t
            WHERE t.pool_id = ANY($1)
              ${confirmedFilter}
            ORDER BY t.block_ts DESC, t.event_id DESC
            LIMIT $2 OFFSET $3`,
          [poolIds, limit, offset],
        )
        : await q<LpRow>(
          `SELECT event_id::text, height::text, block_ts, kind,
                  amount1::text, amount2::text, amount_ctl::text, confirmed,
                  ${ctlAfterCol}
             FROM lp_events t
            WHERE t.pool_id = ANY($1)
              AND ${cursorWhere('event_id')}
              ${confirmedFilter}
            ORDER BY t.block_ts DESC, t.event_id DESC
            LIMIT ${cursorLimitParam}`,
          [poolIds, ...cursorParams, limit],
        );
      const trades = rows.map((r) => {
        const ctlAfter = r.ctl_after ? Number(r.ctl_after) : null;
        const amtCtl = Number(r.amount_ctl);
        const base = r.kind === 'Withdraw' ? (ctlAfter ?? 0) + amtCtl : ctlAfter;
        const share = base && base > 0
          ? Math.min((amtCtl / base) * 100, 100)
          : null;
        const liquidityPct = share === null
          ? null
          : r.kind === 'Withdraw' ? -share : share;
        return {
          event_id: Number(r.event_id),
          timestamp: Math.floor(r.block_ts.getTime() / 1000),
          height: Number(r.height),
          kind: r.kind,
          amount1: r.amount1,
          amount2: r.amount2,
          amount_ctl: r.amount_ctl,
          liquidity_pct: liquidityPct,
          confirmed: r.confirmed,
        };
      });
      const total = count
        ? await countRows('lp_events', poolIds, include_unconfirmed)
        : null;
      void reply.header('cache-control', 'public, max-age=15');
      return {
        trades,
        before: useOffset ? null : trades.at(-1)?.timestamp ?? null,
        before_id: useOffset ? null : trades.at(-1)?.event_id ?? null,
        offset: useOffset ? offset : null,
        limit,
        total,
      };
    }

    // lastHeight/beamUsd are only consumed by this (Trade) branch; batch them
    // with the independent rows query instead of awaiting serially up front.
    const [lastHeight, beamUsd, { rows }] = await Promise.all([
      readLastIndexedHeight(),
      readBeamUsd(),
      useOffset
        ? q<TradeRow>(
          `SELECT t.trade_id::text, t.height::text, t.block_ts,
                  t.aid_in::text, t.aid_out::text,
                  t.amount_in::text, t.amount_out::text,
                  t.volume_aid1::text, t.volume_aid2::text,
                  t.price_native::text,
                  t.confirmed,
                  p.aid1::text, a1.decimals AS decimals1
             FROM trades t
             JOIN pools p   ON p.pool_id = t.pool_id
             JOIN assets a1 ON a1.aid    = p.aid1
            WHERE t.pool_id = ANY($1)
              ${confirmedFilter}
            ORDER BY t.block_ts DESC, t.trade_id DESC
            LIMIT $2 OFFSET $3`,
          [poolIds, limit, offset],
        )
        : q<TradeRow>(
          `SELECT t.trade_id::text, t.height::text, t.block_ts,
                  t.aid_in::text, t.aid_out::text,
                  t.amount_in::text, t.amount_out::text,
                  t.volume_aid1::text, t.volume_aid2::text,
                  t.price_native::text,
                  t.confirmed,
                  p.aid1::text, a1.decimals AS decimals1
             FROM trades t
             JOIN pools p   ON p.pool_id = t.pool_id
             JOIN assets a1 ON a1.aid    = p.aid1
            WHERE t.pool_id = ANY($1)
              AND ${cursorWhere('trade_id')}
              ${confirmedFilter}
            ORDER BY t.block_ts DESC, t.trade_id DESC
            LIMIT ${cursorLimitParam}`,
          [poolIds, ...cursorParams, limit],
        ),
    ]);

    const trades = rows.map((r) => {
      const aid1 = Number(r.aid1);
      const aidIn = Number(r.aid_in);
      const priceNative = r.price_native ? Number(r.price_native) : null;
      // buy = the base (aid1) was acquired, i.e. the target (aid2) was paid in.
      // Per the AMM Trade primitive (m_Buy1 = buy aid1), aid_in == aid1 means the
      // user paid the base → sell.
      const side: 'buy' | 'sell' = aidIn === aid1 ? 'sell' : 'buy';
      const volumeAid1Human = r.volume_aid1
        ? Number(r.volume_aid1) / 10 ** r.decimals1
        : null;
      const priceUsd =
        beamUsd !== null && priceNative !== null && aid1 === 0
          ? priceNative > 0
            ? beamUsd / priceNative
            : null
          : null;
      const valueUsd =
        beamUsd !== null && volumeAid1Human !== null && aid1 === 0
          ? +(volumeAid1Human * beamUsd).toFixed(4)
          : null;

      return {
        trade_id: Number(r.trade_id),
        timestamp: Math.floor(r.block_ts.getTime() / 1000),
        height: Number(r.height),
        aid_in: aidIn,
        aid_out: Number(r.aid_out),
        amount_in: r.amount_in,
        amount_out: r.amount_out,
        side,
        price_native: priceNative,
        price_usd: priceUsd,
        value_usd: valueUsd,
        confirmed: r.confirmed,
        confirmations: r.confirmed ? 80 : Math.max(0, lastHeight - Number(r.height)),
      };
    });

    const total = count
      ? await countRows('trades', poolIds, include_unconfirmed)
      : null;
    void reply.header('cache-control', 'public, max-age=15');
    return {
      trades,
      before: useOffset ? null : trades.at(-1)?.timestamp ?? null,
      before_id: useOffset ? null : trades.at(-1)?.trade_id ?? null,
      offset: useOffset ? offset : null,
      limit,
      total,
    };
  });
}

// Total row count for a pool, honouring the unconfirmed filter so the
// "of N entries" denominator matches the rows actually paged through.
async function countRows(
  table: 'trades' | 'lp_events',
  poolIds: number[],
  includeUnconfirmed: boolean,
): Promise<number> {
  const filter = includeUnconfirmed ? '' : 'AND confirmed = TRUE';
  const { rows } = await q<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${table} WHERE pool_id = ANY($1) ${filter}`,
    [poolIds],
  );
  return rows[0] ? Number(rows[0].n) : 0;
}

// ---------------------------------------------------------------------------
// GET /api/trades — DEX-wide trade tape, newest first.
//
// Same per-trade shape as /api/pairs/{id}/trades plus the pool identity fields
// a consumer needs when rows arrive from many pools at once. Cursor-only
// pagination (`before`): with no pool filter there is no stable offset to page
// against while the indexer keeps writing to the head of the feed.
// ---------------------------------------------------------------------------

const GLOBAL_KIND_LABEL: Record<number, string> = { 0: 'Low', 1: 'Medium', 2: 'High' };

const GlobalQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.coerce.number().int().positive().optional(),
  before_id: z.coerce.number().int().positive().optional(),
  include_unconfirmed: queryBool(true),
  include_imposters: queryBool(false),
  kind: z.coerce.number().int().min(0).max(2).optional(),
  aid: z.coerce.number().int().min(0).optional(),
});

interface GlobalTradeRow extends TradeRow {
  pool_id: string;
  aid2: string;
  kind: number;
  symbol1: string | null;
  symbol2: string | null;
}

export async function globalTradesRoutes(app: FastifyInstance): Promise<void> {
  app.get('/trades', async (req, reply) => {
    const parsed = GlobalQuery.safeParse(req.query);
    if (!parsed.success) {
      throw BadRequest('BAD_REQUEST', parsed.error.issues[0]?.message ?? 'invalid query');
    }
    const { limit, before, before_id, include_unconfirmed, include_imposters, kind, aid } = parsed.data;

    const beforeTs = before ? new Date(before * 1000) : new Date();
    const where: string[] = ['p.destroyed_at_height IS NULL'];
    const params: (Date | number | boolean)[] = [beforeTs];
    // Keyset cursor (see the per-pair route): both halves resume exactly after
    // the last row seen; `before` alone stays a plain timestamp bound.
    if (before !== undefined && before_id !== undefined) {
      params.push(before_id);
      where.push('(t.block_ts, t.trade_id) < ($1, $2)');
    } else {
      where.push('t.block_ts < $1');
    }

    if (!include_unconfirmed) where.push('t.confirmed = TRUE');
    if (!include_imposters) where.push('a1.is_imposter = FALSE', 'a2.is_imposter = FALSE');
    if (kind !== undefined) {
      params.push(kind);
      where.push(`p.kind = $${params.length}`);
    }
    if (aid !== undefined) {
      params.push(aid);
      where.push(`(p.aid1 = $${params.length} OR p.aid2 = $${params.length})`);
    }
    params.push(limit);

    const [lastHeight, usd, { rows }] = await Promise.all([
      readLastIndexedHeight(),
      loadUsdTable(),
      q<GlobalTradeRow>(
        `SELECT t.trade_id::text, t.height::text, t.block_ts,
                t.aid_in::text, t.aid_out::text,
                t.amount_in::text, t.amount_out::text,
                t.volume_aid1::text, t.volume_aid2::text,
                t.price_native::text,
                t.confirmed,
                p.pool_id::text, p.aid1::text, p.aid2::text, p.kind,
                a1.decimals AS decimals1,
                a1.short_name AS symbol1, a2.short_name AS symbol2
           FROM trades t
           JOIN pools p   ON p.pool_id = t.pool_id
           JOIN assets a1 ON a1.aid    = p.aid1
           JOIN assets a2 ON a2.aid    = p.aid2
          WHERE ${where.join(' AND ')}
          ORDER BY t.block_ts DESC, t.trade_id DESC
          LIMIT $${params.length}`,
        params,
      ),
    ]);

    const trades = rows.map((r) => {
      const aid1 = Number(r.aid1);
      const aidIn = Number(r.aid_in);
      const priceNative = r.price_native ? Number(r.price_native) : null;
      // See the per-pair handler: aid_in == aid1 means the base was paid in.
      const side: 'buy' | 'sell' = aidIn === aid1 ? 'sell' : 'buy';
      const volumeAid1Human = r.volume_aid1
        ? Number(r.volume_aid1) / 10 ** r.decimals1
        : null;
      // Unlike the per-pair route (BEAM-base only), price the base off the
      // shared USD table so non-BEAM-quoted pools carry USD figures too. For a
      // BEAM base the rate is beam_usd, so the two agree by construction.
      const usdPerBase = usd.perAid.get(aid1) ?? null;
      const priceUsd =
        usdPerBase !== null && priceNative !== null && priceNative > 0
          ? usdPerBase / priceNative
          : null;
      const valueUsd =
        usdPerBase !== null && volumeAid1Human !== null
          ? +(volumeAid1Human * usdPerBase).toFixed(4)
          : null;

      return {
        trade_id: Number(r.trade_id),
        pool_id: Number(r.pool_id),
        pair_id: Number(r.pool_id),
        aid1,
        aid2: Number(r.aid2),
        symbol1: r.symbol1,
        symbol2: r.symbol2,
        kind: r.kind,
        kind_label: GLOBAL_KIND_LABEL[r.kind] ?? 'Unknown',
        timestamp: Math.floor(r.block_ts.getTime() / 1000),
        height: Number(r.height),
        aid_in: aidIn,
        aid_out: Number(r.aid_out),
        amount_in: r.amount_in,
        amount_out: r.amount_out,
        side,
        price_native: priceNative,
        price_usd: priceUsd,
        value_usd: valueUsd,
        confirmed: r.confirmed,
        confirmations: r.confirmed ? 80 : Math.max(0, lastHeight - Number(r.height)),
      };
    });

    void reply.header('cache-control', 'public, max-age=15');
    return {
      trades,
      before: trades.at(-1)?.timestamp ?? null,
      before_id: trades.at(-1)?.trade_id ?? null,
      limit,
    };
  });
}
