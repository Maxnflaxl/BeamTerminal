import { config } from '../../config.js';
import { q } from '../../db.js';
import { getLatestUsdPrices, valueUsd } from '../../services/pricing.js';
import { readDaoStat, writeDaoStat } from './daoStatsCache.js';

// DAO revenue = fees skimmed into DaoVault. The vault's Deposit inflows give the
// total (across every fee source) and the per-asset/time breakdown; per-pool and
// per-tier detail comes from trades.fee_groth (DEX only). "By source" splits DEX
// (measured from trades) from Other (the remaining vault inflows — Nephrite, BANS,
// …); finer per-source attribution needs those contracts watched individually.

export interface DaoRevenue {
  total_usd: number;
  series: { day: string; by_asset: Record<string, number> }[];
  by_source: { source: string; usd: number; pct: number }[];
  by_tier: { tier: number; usd: number }[];
  top_pools: { pool_id: number; pair: string; tier: number; usd: number }[];
}

export async function computeDaoRevenue(): Promise<DaoRevenue> {
  const vaultCid = config.DAO_VAULT_CID;
  const prices = await getLatestUsdPrices();
  const symbolOf = (aid: number): string => prices.get(aid)?.symbol ?? `aid:${aid}`;

  // Total inflows over time, per asset, from vault Deposits (positive funds).
  const series: { day: string; by_asset: Record<string, number> }[] = [];
  let total_usd = 0;
  if (vaultCid) {
    const { rows } = await q<{ day: string; aid: string; groths: string }>(
      `SELECT to_char(date_trunc('day', block_ts), 'YYYY-MM-DD') AS day,
              (kv.key)::bigint AS aid, SUM((kv.value)::numeric)::text AS groths
         FROM contract_call_events e, jsonb_each_text(e.funds) kv
        WHERE e.cid = $1 AND e.method = 'Deposit' AND e.funds IS NOT NULL
          AND (kv.value)::numeric > 0
        GROUP BY 1, 2
        ORDER BY 1`,
      [vaultCid],
    );
    const byDay = new Map<string, Record<string, number>>();
    for (const r of rows) {
      const usd = valueUsd(prices.get(Number(r.aid)), r.groths) ?? 0;
      total_usd += usd;
      const sym = symbolOf(Number(r.aid));
      const d = byDay.get(r.day) ?? {};
      d[sym] = (d[sym] ?? 0) + usd;
      byDay.set(r.day, d);
    }
    for (const [day, by_asset] of byDay) series.push({ day, by_asset });
  }

  // DEX fees from trades, valued by the fee asset (aid_in), grouped by pool + tier.
  const { rows: feeRows } = await q<{ pool_id: string; aid1: string; aid2: string; tier: number; aid_in: string; fee: string }>(
    `SELECT t.pool_id, p.aid1, p.aid2, p.kind AS tier, t.aid_in, SUM(t.fee_groth)::text AS fee
       FROM trades t
       JOIN pools p ON p.pool_id = t.pool_id
      WHERE t.fee_groth IS NOT NULL AND t.confirmed = TRUE
      GROUP BY t.pool_id, p.aid1, p.aid2, p.kind, t.aid_in`,
  );
  const poolUsd = new Map<number, { pair: string; tier: number; usd: number }>();
  const tierUsd = new Map<number, number>();
  let dexUsd = 0;
  for (const r of feeRows) {
    const usd = valueUsd(prices.get(Number(r.aid_in)), r.fee) ?? 0;
    dexUsd += usd;
    const poolId = Number(r.pool_id);
    const cur = poolUsd.get(poolId) ?? { pair: `${symbolOf(Number(r.aid1))}/${symbolOf(Number(r.aid2))}`, tier: r.tier, usd: 0 };
    cur.usd += usd;
    poolUsd.set(poolId, cur);
    tierUsd.set(r.tier, (tierUsd.get(r.tier) ?? 0) + usd);
  }

  const top_pools = [...poolUsd.entries()]
    .map(([pool_id, v]) => ({ pool_id, ...v }))
    .sort((a, b) => b.usd - a.usd)
    .slice(0, 20);
  const by_tier = [...tierUsd.entries()].map(([tier, usd]) => ({ tier, usd })).sort((a, b) => a.tier - b.tier);

  const otherUsd = Math.max(0, total_usd - dexUsd);
  const srcTotal = dexUsd + otherUsd || 1;
  const by_source = [
    { source: 'DEX', usd: dexUsd, pct: (dexUsd / srcTotal) * 100 },
    { source: 'Other', usd: otherUsd, pct: (otherUsd / srcTotal) * 100 },
  ];

  return { total_usd, series, by_source, by_tier, top_pools };
}

/** Cached read; on a miss, computes live once and warms the cache. */
export async function loadDaoRevenue(): Promise<DaoRevenue> {
  const cached = await readDaoStat<DaoRevenue>('revenue');
  if (cached) return cached;
  const fresh = await computeDaoRevenue();
  await writeDaoStat('revenue', fresh);
  return fresh;
}
