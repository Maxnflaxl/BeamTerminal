import { q } from '../db.js';

// Per-asset USD valuation, mirroring the cross-rate methodology in dexStats.ts:
// BEAM/USD comes from the oracle; every other asset is priced off its
// largest-BEAM-reserve pool (aid1 = 0), decimals-adjusted. Assets with no
// BEAM-paired pool are unpriceable and carry `usdPerUnit: null`.

export interface AssetPrice {
  aid: number;
  decimals: number;
  symbol: string;
  /** USD per 1 whole unit of the asset; null when the asset has no BEAM pool. */
  usdPerUnit: number | null;
}

/** Latest USD price per catalogued asset, keyed by aid. */
export async function getLatestUsdPrices(): Promise<Map<number, AssetPrice>> {
  const { rows } = await q<{ aid: string; decimals: number; symbol: string | null; usd_per_unit: string | null }>(
    `WITH beam AS (
       SELECT last(beam_usd, ts) AS usd FROM oracle_snapshots
     ),
     latest_pool AS (
       SELECT DISTINCT ON (pool_id) pool_id,
              reserve1::numeric AS reserve1, reserve2::numeric AS reserve2
         FROM pool_state_snapshots
        ORDER BY pool_id, ts DESC
     ),
     beam_paired AS (
       SELECT DISTINCT ON (p.aid2) p.aid2 AS asset_aid,
              lp.reserve1 AS beam_reserve, lp.reserve2 AS asset_reserve
         FROM latest_pool lp
         JOIN pools p ON p.pool_id = lp.pool_id
        WHERE p.aid1 = 0 AND lp.reserve1 > 0 AND lp.reserve2 > 0
        ORDER BY p.aid2, lp.reserve1 DESC
     )
     SELECT a.aid::text AS aid,
            a.decimals,
            COALESCE(a.short_name, a.unit_name, a.name) AS symbol,
            CASE
              WHEN a.aid = 0 THEN (SELECT usd FROM beam)
              WHEN bp.beam_reserve IS NOT NULL THEN
                (bp.beam_reserve / 1e8::numeric)
                / NULLIF(bp.asset_reserve / power(10::numeric, a.decimals), 0)
                * (SELECT usd FROM beam)
              ELSE NULL
            END::text AS usd_per_unit
       FROM assets a
       LEFT JOIN beam_paired bp ON bp.asset_aid = a.aid`,
  );
  const m = new Map<number, AssetPrice>();
  for (const r of rows) {
    const aid = Number(r.aid);
    m.set(aid, {
      aid,
      decimals: r.decimals,
      symbol: r.symbol ?? `aid:${aid}`,
      usdPerUnit: r.usd_per_unit != null ? Number(r.usd_per_unit) : null,
    });
  }
  return m;
}

/** USD value of `amountGroths` of an asset, or null when the asset is unpriceable. */
export function valueUsd(price: AssetPrice | undefined, amountGroths: string | bigint): number | null {
  if (!price || price.usdPerUnit == null) return null;
  const whole = Number(amountGroths) / Math.pow(10, price.decimals);
  return whole * price.usdPerUnit;
}
