import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q } from '../../db.js';
import { BadRequest, NotFound } from '../error.js';
import { listPairs, resolvePairId, type PairRowRaw, type SortKey } from '../repos/pairs.js';
import { loadUsdTable, type UsdTable } from '../repos/usd.js';
import { loadSparklines7d } from '../repos/sparklines.js';

const KIND_LABEL: Record<number, string> = { 0: 'Low', 1: 'Medium', 2: 'High' };

interface ResponsePair {
  pair_id: number;
  aid1: number;
  aid2: number;
  symbol1: string | null;
  symbol2: string | null;
  kind: number;
  kind_label: string;
  decimals1: number;
  decimals2: number;

  price_native: number | null;
  price_usd: number | null;
  rate_2_1: number | null;

  reserve1: string | null;
  reserve2: string | null;
  reserve1_human: number | null;
  reserve2_human: number | null;
  reserve1_usd: number | null;
  reserve2_usd: number | null;
  tvl_usd: number | null;

  /** Total LP-token supply (groths of aid_ctl) at the latest snapshot. */
  ctl_supply: string | null;
  /** Height of the latest pool-state snapshot the reserves/ctl_supply are from. */
  snapshot_height: number | null;

  volume_24h_groth: string;
  volume_24h_usd: number | null;

  price_change_24h: number | null;

  buys_24h: number;
  sells_24h: number;
  trades_24h: number;

  is_imposter: boolean;
  lp_token: number;
  created_at_height: number;

  sparkline_7d: number[];
}

async function readLastIndexedHeight(): Promise<number> {
  const { rows } = await q<{ last_indexed_height: string }>(
    'SELECT last_indexed_height::text AS last_indexed_height FROM cursor WHERE id = 1',
  );
  return rows[0] ? Number(rows[0].last_indexed_height) : 0;
}

function toResponse(
  row: PairRowRaw,
  usd: UsdTable,
  sparkline: number[] = [],
): ResponsePair {
  const aid1 = Number(row.aid1);
  const aid2 = Number(row.aid2);
  const usdPerAid1 = usd.perAid.get(aid1) ?? null;
  const usdPerAid2 = usd.perAid.get(aid2) ?? null;
  const r1 = row.reserve1 ? Number(row.reserve1) / 10 ** row.decimals1 : null;
  const r2 = row.reserve2 ? Number(row.reserve2) / 10 ** row.decimals2 : null;
  const lastPriceNative = row.last_price_native ? Number(row.last_price_native) : null;
  // Fallback price: pool reserve ratio (aid2 per aid1).
  const fallbackPrice =
    r1 !== null && r2 !== null && r1 > 0 ? r2 / r1 : null;
  const priceNative = lastPriceNative ?? fallbackPrice;

  // USD valuation: prefer per-AID rates from the multi-hop helper. Each side
  // is priced via its deepest BEAM-quoted pool. price_usd is reported for the
  // target asset (aid2) when we have a rate for it.
  const r1Usd = r1 !== null && usdPerAid1 !== null ? +(r1 * usdPerAid1).toFixed(2) : null;
  const r2Usd = r2 !== null && usdPerAid2 !== null ? +(r2 * usdPerAid2).toFixed(2) : null;
  const priceUsd = usdPerAid2 ?? (
    priceNative !== null && usdPerAid1 !== null && priceNative > 0
      ? usdPerAid1 / priceNative
      : null
  );
  const tvlUsd = r1Usd !== null && r2Usd !== null ? +(r1Usd + r2Usd).toFixed(2) : null;

  const volumeAid1Human = row.volume_24h_aid1
    ? Number(row.volume_24h_aid1) / 10 ** row.decimals1
    : 0;
  const volumeUsd =
    usdPerAid1 !== null ? +(volumeAid1Human * usdPerAid1).toFixed(2) : null;

  let priceChange24h: number | null = null;
  if (lastPriceNative !== null && row.price_24h_ago) {
    const prev = Number(row.price_24h_ago);
    if (prev > 0) priceChange24h = +(((lastPriceNative - prev) / prev) * 100).toFixed(4);
  }

  return {
    pair_id: Number(row.pool_id),
    aid1,
    aid2,
    symbol1: row.symbol1,
    symbol2: row.symbol2,
    kind: row.kind,
    kind_label: KIND_LABEL[row.kind] ?? 'Unknown',
    decimals1: row.decimals1,
    decimals2: row.decimals2,
    price_native: priceNative,
    price_usd: priceUsd,
    rate_2_1: priceNative !== null && priceNative > 0 ? 1 / priceNative : null,
    reserve1: row.reserve1,
    reserve2: row.reserve2,
    reserve1_human: r1,
    reserve2_human: r2,
    reserve1_usd: r1Usd,
    reserve2_usd: r2Usd,
    tvl_usd: tvlUsd,
    ctl_supply: row.ctl_supply,
    snapshot_height: row.snapshot_height !== null ? Number(row.snapshot_height) : null,
    volume_24h_groth: row.volume_24h_aid1 ?? '0',
    volume_24h_usd: volumeUsd,
    price_change_24h: priceChange24h,
    buys_24h: Number(row.buys_24h ?? 0),
    sells_24h: Number(row.sells_24h ?? 0),
    trades_24h: Number(row.trades_24h ?? 0),
    is_imposter: row.is_imposter1 || row.is_imposter2,
    lp_token: Number(row.aid_ctl),
    created_at_height: Number(row.created_at_height),
    sparkline_7d: sparkline,
  };
}

const ListQuery = z.object({
  sort_by: z
    .enum(['tvl_usd', 'volume_24h_usd', 'price_change_24h', 'trades_24h', 'aid2'])
    .default('tvl_usd'),
  order: z.enum(['asc', 'desc']).default('desc'),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().nonnegative().default(0),
  search: z.string().optional(),
  kind: z.coerce.number().int().min(0).max(2).optional(),
  include_imposters: z.coerce.boolean().default(false),
});

export async function pairsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/pairs', async (req, reply) => {
    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) {
      throw BadRequest('BAD_REQUEST', parsed.error.issues[0]?.message ?? 'invalid query');
    }
    const opts = parsed.data;

    // Both `tvl_usd` and `volume_24h_usd` require app-side sort because the
    // USD-per-AID rates come from the multi-hop helper, not SQL. Without this,
    // a tiny TICO/Nph pool (huge raw-groth aid1 reserves but only ~$37 USD)
    // ranks above BEAM/BeamX ($27k USD).
    const needsAppSort = opts.sort_by === 'volume_24h_usd' || opts.sort_by === 'tvl_usd';

    const [usd, lastHeight, rows] = await Promise.all([
      loadUsdTable(),
      readLastIndexedHeight(),
      listPairs({
        // For SQL-side sort we pass the user's choice; for USD-sort we pull
        // a default-ordered window wide enough to cover any reasonable offset.
        sort_by: (needsAppSort ? 'aid2' : opts.sort_by) as SortKey,
        order: 'asc',
        limit: needsAppSort ? 500 : opts.limit,
        offset: needsAppSort ? 0 : opts.offset,
        ...(opts.search !== undefined ? { search: opts.search } : {}),
        ...(opts.kind !== undefined ? { kind: opts.kind as 0 | 1 | 2 } : {}),
        include_imposters: opts.include_imposters,
      }),
    ]);

    let pairs = rows.map((r) => toResponse(r, usd));

    if (needsAppSort) {
      const sign = opts.order === 'asc' ? 1 : -1;
      const key = opts.sort_by === 'tvl_usd' ? 'tvl_usd' : 'volume_24h_usd';
      pairs.sort((a, b) => {
        const av = a[key] ?? -Infinity;
        const bv = b[key] ?? -Infinity;
        return (av - bv) * sign;
      });
      pairs = pairs.slice(opts.offset, opts.offset + opts.limit);
    }

    // Backfill sparkline_7d only for the final visible page (post-sort/slice)
    // to avoid loading 4h candles for the 500-row super-set used in app-sort.
    const sparklines = await loadSparklines7d(pairs.map((p) => p.pair_id));
    pairs = pairs.map((p) => ({ ...p, sparkline_7d: sparklines.get(p.pair_id) ?? [] }));

    void reply.header('cache-control', 'public, max-age=15');
    return { pairs, total: pairs.length, last_indexed_height: lastHeight };
  });

  app.get<{ Params: { id: string } }>('/pairs/:id', async (req, reply) => {
    const poolId = await resolvePairId(req.params.id);
    if (poolId === null) {
      throw NotFound('PAIR_NOT_FOUND', `no pair matching ${req.params.id}`);
    }
    const rows = await listPairs({
      sort_by: 'aid2',
      order: 'asc',
      limit: 500,
      offset: 0,
      include_imposters: true,
    });
    const row = rows.find((r) => Number(r.pool_id) === poolId);
    if (!row) throw NotFound('PAIR_NOT_FOUND', `pool ${poolId} not found`);

    const [usd, sparklines] = await Promise.all([
      loadUsdTable(),
      loadSparklines7d([poolId]),
    ]);
    void reply.header('cache-control', 'public, max-age=15');
    return toResponse(row, usd, sparklines.get(poolId) ?? []);
  });
}
