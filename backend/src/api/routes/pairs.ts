import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q } from '../../db.js';
import { BadRequest, NotFound } from '../error.js';
import { listPairs, resolvePair, type PairRowRaw, type SortKey } from '../repos/pairs.js';
import { loadUsdTable, type UsdTable } from '../repos/usd.js';
import { loadSparklines7d } from '../repos/sparklines.js';

const KIND_LABEL: Record<number, string> = { 0: 'Low', 1: 'Medium', 2: 'High' };

/** Per-tier summary attached to a grouped (combined-pair) response. Carries
 *  what the detail-page tier switcher and the swap router need. */
interface ResponsePairTier {
  pool_id: number;
  kind: number;
  kind_label: string;
  lp_token: number;
  tvl_usd: number | null;
  volume_24h_usd: number | null;
  reserve1_human: number | null;
  reserve2_human: number | null;
  price_native: number | null;
}

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

  /** Present only on grouped (combined-pair) responses: one entry per fee tier,
   *  deepest first. Absent on single-tier responses. */
  tiers?: ResponsePairTier[];
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

function bigintSumStr(values: Array<string | null>): string {
  let acc = 0n;
  for (const v of values) if (v) acc += BigInt(v);
  return acc.toString();
}

function numSum(values: Array<number | null>): number | null {
  let acc = 0;
  let any = false;
  for (const v of values) if (v !== null) { acc += v; any = true; }
  return any ? +acc.toFixed(2) : null;
}

/** Collapse the per-tier ResponsePairs of each (aid1, aid2) pair into one
 *  combined row: reserves/volume/txns are summed across tiers, while price and
 *  identity come from the reference (deepest reserve1) tier — matching the
 *  USD-valuation convention in repos/usd.ts. */
function groupByPair(pairs: ResponsePair[]): ResponsePair[] {
  const groups = new Map<string, ResponsePair[]>();
  for (const p of pairs) {
    const key = `${p.aid1}-${p.aid2}`;
    const g = groups.get(key);
    if (g) g.push(p); else groups.set(key, [p]);
  }

  const out: ResponsePair[] = [];
  for (const tiers of groups.values()) {
    // Reference tier = deepest by reserve1 groths (comparable across tiers of
    // the same pair, which share aid1/aid2).
    const ref = tiers.reduce((a, b) =>
      (BigInt(b.reserve1 ?? '0') > BigInt(a.reserve1 ?? '0') ? b : a));

    out.push({
      ...ref,
      reserve1: bigintSumStr(tiers.map((t) => t.reserve1)),
      reserve2: bigintSumStr(tiers.map((t) => t.reserve2)),
      reserve1_human: numSum(tiers.map((t) => t.reserve1_human)),
      reserve2_human: numSum(tiers.map((t) => t.reserve2_human)),
      reserve1_usd: numSum(tiers.map((t) => t.reserve1_usd)),
      reserve2_usd: numSum(tiers.map((t) => t.reserve2_usd)),
      tvl_usd: numSum(tiers.map((t) => t.tvl_usd)),
      volume_24h_groth: bigintSumStr(tiers.map((t) => t.volume_24h_groth)),
      volume_24h_usd: numSum(tiers.map((t) => t.volume_24h_usd)),
      buys_24h: tiers.reduce((s, t) => s + t.buys_24h, 0),
      sells_24h: tiers.reduce((s, t) => s + t.sells_24h, 0),
      trades_24h: tiers.reduce((s, t) => s + t.trades_24h, 0),
      tiers: tiers
        .slice()
        .sort((a, b) => (BigInt(b.reserve1 ?? '0') > BigInt(a.reserve1 ?? '0') ? 1 : -1))
        .map((t) => ({
          pool_id: t.pair_id,
          kind: t.kind,
          kind_label: t.kind_label,
          lp_token: t.lp_token,
          tvl_usd: t.tvl_usd,
          volume_24h_usd: t.volume_24h_usd,
          reserve1_human: t.reserve1_human,
          reserve2_human: t.reserve2_human,
          price_native: t.price_native,
        })),
    });
  }
  return out;
}

function sortValue(p: ResponsePair, key: SortKey): number {
  switch (key) {
    case 'tvl_usd': return p.tvl_usd ?? -Infinity;
    case 'volume_24h_usd': return p.volume_24h_usd ?? -Infinity;
    case 'price_change_24h': return p.price_change_24h ?? -Infinity;
    case 'trades_24h': return p.trades_24h;
    case 'aid2': return p.aid2;
    default: return -Infinity;
  }
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
  // 'pair' collapses fee tiers into one combined row per (aid1, aid2).
  group: z.enum(['tier', 'pair']).default('tier'),
});

export async function pairsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/pairs', async (req, reply) => {
    const parsed = ListQuery.safeParse(req.query);
    if (!parsed.success) {
      throw BadRequest('BAD_REQUEST', parsed.error.issues[0]?.message ?? 'invalid query');
    }
    const opts = parsed.data;

    // App-side sort/slice is required when:
    //  - sorting by a USD figure (`tvl_usd`/`volume_24h_usd`): the USD-per-AID
    //    rates come from the multi-hop helper, not SQL — otherwise a tiny
    //    TICO/Nph pool (huge raw-groth reserves, ~$37 USD) ranks above
    //    BEAM/BeamX ($27k USD).
    //  - grouping by pair: tiers are collapsed in JS, so any sort/slice must
    //    happen after the merge.
    const grouped = opts.group === 'pair';
    const needsAppSort = grouped
      || opts.sort_by === 'volume_24h_usd' || opts.sort_by === 'tvl_usd';

    const [usd, lastHeight, rows] = await Promise.all([
      loadUsdTable(),
      readLastIndexedHeight(),
      listPairs({
        // For SQL-side sort we pass the user's choice; otherwise pull a
        // default-ordered window wide enough to cover any reasonable offset.
        sort_by: (needsAppSort ? 'aid2' : opts.sort_by) as SortKey,
        order: needsAppSort ? 'asc' : opts.order,
        limit: needsAppSort ? 500 : opts.limit,
        offset: needsAppSort ? 0 : opts.offset,
        ...(opts.search !== undefined ? { search: opts.search } : {}),
        ...(opts.kind !== undefined ? { kind: opts.kind as 0 | 1 | 2 } : {}),
        include_imposters: opts.include_imposters,
      }),
    ]);

    let pairs = rows.map((r) => toResponse(r, usd));
    if (grouped) pairs = groupByPair(pairs);

    const total = pairs.length;

    if (needsAppSort) {
      const sign = opts.order === 'asc' ? 1 : -1;
      pairs.sort((a, b) => (sortValue(a, opts.sort_by) - sortValue(b, opts.sort_by)) * sign);
      pairs = pairs.slice(opts.offset, opts.offset + opts.limit);
    }

    // Backfill sparkline_7d only for the final visible page (post-sort/slice)
    // to avoid loading 4h candles for the 500-row super-set used in app-sort.
    // pair_id is the reference (deepest) pool for grouped rows.
    const sparklines = await loadSparklines7d(pairs.map((p) => p.pair_id));
    pairs = pairs.map((p) => ({ ...p, sparkline_7d: sparklines.get(p.pair_id) ?? [] }));

    void reply.header('cache-control', 'public, max-age=15');
    return { pairs, total, last_indexed_height: lastHeight };
  });

  app.get<{ Params: { id: string } }>('/pairs/:id', async (req, reply) => {
    const resolved = await resolvePair(req.params.id);
    if (resolved === null) {
      throw NotFound('PAIR_NOT_FOUND', `no pair matching ${req.params.id}`);
    }
    const poolIds = new Set(resolved.poolIds);
    const rows = await listPairs({
      sort_by: 'aid2',
      order: 'asc',
      limit: 500,
      offset: 0,
      include_imposters: true,
    });
    const mine = rows.filter((r) => poolIds.has(Number(r.pool_id)));
    if (mine.length === 0) throw NotFound('PAIR_NOT_FOUND', `pool ${resolved.refPoolId} not found`);

    const [usd, sparklines] = await Promise.all([
      loadUsdTable(),
      loadSparklines7d([resolved.refPoolId]),
    ]);
    const mapped = mine.map((r) => toResponse(r, usd));
    // Combined (multi-tier) reference → grouped row; single tier → that row.
    const result = resolved.poolIds.length > 1
      ? groupByPair(mapped)[0]!
      : mapped.find((p) => p.pair_id === resolved.refPoolId) ?? mapped[0]!;
    result.sparkline_7d = sparklines.get(resolved.refPoolId) ?? [];

    void reply.header('cache-control', 'public, max-age=15');
    return result;
  });
}
