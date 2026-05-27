import { q } from '../../db.js';

/**
 * Historical BEAM / USD valuation, parameterised by block height — the
 * point-in-time analogue of `loadUsdTable` (repos/usd.ts).
 *
 * For a `(aid, height)` request it answers "what was 1 whole unit of `aid`
 * worth, in BEAM and in USD, at that height?":
 *   - BEAM/USD reference  = nearest `oracle_snapshots` row at/before `height`.
 *   - BEAM-per-whole-aid  = reserves of the asset's deepest BEAM-quoted pool
 *                           (aid1 = 0 = BEAM) at/before `height`.
 *   - USD-per-whole-aid   = BEAM-per-whole-aid × BEAM/USD.
 *
 * Single-hop only, exactly like the present-time helper: assets with no direct
 * BEAM pool resolve to `null` (no BEAM/USD valuation). Multi-hop routing
 * (X→Y→BEAM) is intentionally out of scope.
 *
 * Batched: pass every `(aid, height)` the caller needs and get one Map back.
 */
export interface HistPrice {
  /** BEAM per 1 whole unit of the asset, or null when not reachable. */
  beamPerWhole: number | null;
  /** USD per 1 whole unit of the asset, or null when not reachable. */
  usdPerWhole: number | null;
}

const key = (aid: number, height: number): string => `${aid}:${height}`;

export async function loadHistoricalPrices(
  reqs: ReadonlyArray<{ aid: number; height: number }>,
): Promise<Map<string, HistPrice>> {
  const out = new Map<string, HistPrice>();
  if (reqs.length === 0) return out;

  const heights = [...new Set(reqs.map((r) => r.height))];
  const aids = [...new Set(reqs.map((r) => r.aid))];
  const nonBeamAids = aids.filter((a) => a !== 0);

  // 1) BEAM/USD at each height (nearest snapshot at/before).
  const { rows: oracleRows } = await q<{ height: string; beam_usd: string | null }>(
    `SELECT t.h::text AS height,
            (SELECT o.beam_usd FROM oracle_snapshots o
              WHERE o.height <= t.h ORDER BY o.height DESC LIMIT 1)::text AS beam_usd
       FROM unnest($1::bigint[]) AS t(h)`,
    [heights],
  );
  const beamUsdAt = new Map<number, number | null>();
  for (const r of oracleRows) {
    beamUsdAt.set(Number(r.height), r.beam_usd !== null ? Number(r.beam_usd) : null);
  }

  // 2) Pick each non-BEAM asset's BEAM-routing pool: deepest by *current* BEAM
  //    reserve (stable choice, mirrors loadUsdTable's "deepest pool").
  const routePool = new Map<number, { poolId: number; otherDecimals: number }>();
  if (nonBeamAids.length > 0) {
    const { rows: poolRows } = await q<{ aid: string; pool_id: string; other_decimals: number }>(
      `WITH latest AS (
         SELECT DISTINCT ON (pool_id) pool_id, reserve1
           FROM pool_state_snapshots ORDER BY pool_id, ts DESC
       ),
       beam_pools AS (
         SELECT p.pool_id, p.aid2 AS aid, l.reserve1 AS beam_reserve, a2.decimals AS other_decimals
           FROM pools p
           JOIN latest l  ON l.pool_id = p.pool_id
           JOIN assets a2 ON a2.aid = p.aid2
          WHERE p.aid1 = 0 AND p.destroyed_at_height IS NULL AND l.reserve1 > 0
       ),
       ranked AS (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY aid ORDER BY beam_reserve DESC) AS rn
           FROM beam_pools
       )
       SELECT aid::text, pool_id::text, other_decimals
         FROM ranked WHERE rn = 1 AND aid = ANY($1::bigint[])`,
      [nonBeamAids],
    );
    for (const r of poolRows) {
      routePool.set(Number(r.aid), { poolId: Number(r.pool_id), otherDecimals: r.other_decimals });
    }
  }

  // 3) Historical reserves of each needed (routing pool, height) pair.
  const poolHeightPairs: Array<{ aid: number; poolId: number; height: number }> = [];
  for (const { aid, height } of reqs) {
    const rp = routePool.get(aid);
    if (rp) poolHeightPairs.push({ aid, poolId: rp.poolId, height });
  }
  const beamPerWholeAt = new Map<string, number | null>(); // key by `${aid}:${height}`
  if (poolHeightPairs.length > 0) {
    const poolIds = poolHeightPairs.map((p) => p.poolId);
    const hs = poolHeightPairs.map((p) => p.height);
    const { rows: resRows } = await q<{
      pool_id: string;
      height: string;
      reserve1: string | null;
      reserve2: string | null;
    }>(
      `SELECT t.pool_id::text AS pool_id, t.h::text AS height,
              snap.reserve1::text AS reserve1, snap.reserve2::text AS reserve2
         FROM unnest($1::bigint[], $2::bigint[]) AS t(pool_id, h)
         LEFT JOIN LATERAL (
           SELECT reserve1, reserve2 FROM pool_state_snapshots s
            WHERE s.pool_id = t.pool_id AND s.height <= t.h
            ORDER BY s.height DESC LIMIT 1
         ) snap ON TRUE`,
      [poolIds, hs],
    );
    // Index reserves by (pool_id, height) then map back to (aid, height).
    const reservesByPoolHeight = new Map<string, { r1: string | null; r2: string | null }>();
    for (const r of resRows) {
      reservesByPoolHeight.set(`${r.pool_id}:${r.height}`, { r1: r.reserve1, r2: r.reserve2 });
    }
    for (const { aid, poolId, height } of poolHeightPairs) {
      const res = reservesByPoolHeight.get(`${poolId}:${height}`);
      const rp = routePool.get(aid)!;
      if (!res || res.r1 === null || res.r2 === null) {
        beamPerWholeAt.set(key(aid, height), null);
        continue;
      }
      const beamReserve = Number(res.r1) / 1e8; // BEAM has 8 decimals
      const otherReserve = Number(res.r2) / 10 ** rp.otherDecimals;
      beamPerWholeAt.set(key(aid, height), otherReserve > 0 ? beamReserve / otherReserve : null);
    }
  }

  // 4) Assemble.
  for (const { aid, height } of reqs) {
    const beamUsd = beamUsdAt.get(height) ?? null;
    const beamPerWhole = aid === 0 ? 1 : beamPerWholeAt.get(key(aid, height)) ?? null;
    const usdPerWhole =
      beamPerWhole !== null && beamUsd !== null ? beamPerWhole * beamUsd : null;
    out.set(key(aid, height), { beamPerWhole, usdPerWhole });
  }
  return out;
}
