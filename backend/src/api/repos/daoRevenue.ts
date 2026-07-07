import { config } from '../../config.js';
import { q } from '../../db.js';
import { getLatestUsdPrices, valueUsd } from '../../services/pricing.js';
import { readDaoStat, writeDaoStat } from './daoStatsCache.js';
import { sourceLabel } from './daoTreasury.js';

// DAO revenue = fees skimmed into DaoVault (the nested Deposit calls). "By
// source" comes from each skim's parent method (Trade→DEX, Trove/Redeem→
// Nephrite, Register/Extend→Names, Create token→Asset Minter). Per-pool/tier
// detail is the DEX slice, measured from trades.fee_groth.

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

  const series: { day: string; by_asset: Record<string, number> }[] = [];
  const bySourceUsd = new Map<string, number>();
  let total_usd = 0;
  if (vaultCid) {
    // Per-day per-asset skim inflows (nested Deposit calls = actual fee income).
    const { rows } = await q<{ day: string; aid: string; groths: string }>(
      `SELECT to_char(date_trunc('day', block_ts), 'YYYY-MM-DD') AS day,
              (kv.key)::bigint AS aid, SUM((kv.value)::numeric)::text AS groths
         FROM contract_call_events e, jsonb_each_text(e.funds) kv
        WHERE e.cid = $1 AND e.method = 'Deposit' AND e.parent_ord IS NOT NULL
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

    // By source = the parent method of each skim.
    const { rows: srcRows } = await q<{ source: string; aid: string; groths: string }>(
      `SELECT p.method AS source, (kv.key)::bigint AS aid, SUM((kv.value)::numeric)::text AS groths
         FROM contract_call_events c
         JOIN contract_call_events p ON p.cid = c.cid AND p.height = c.height AND p.ord = c.parent_ord
         CROSS JOIN LATERAL jsonb_each_text(c.funds) kv
        WHERE c.cid = $1 AND c.method = 'Deposit' AND c.parent_ord IS NOT NULL
        GROUP BY 1, 2`,
      [vaultCid],
    );
    for (const r of srcRows) {
      const usd = valueUsd(prices.get(Number(r.aid)), r.groths) ?? 0;
      const src = sourceLabel(r.source);
      bySourceUsd.set(src, (bySourceUsd.get(src) ?? 0) + usd);
    }
  }

  // DEX per-pool/tier fee detail (from trades).
  const { rows: feeRows } = await q<{ pool_id: string; aid1: string; aid2: string; tier: number; aid_in: string; fee: string }>(
    `SELECT t.pool_id, p.aid1, p.aid2, p.kind AS tier, t.aid_in, SUM(t.fee_groth)::text AS fee
       FROM trades t
       JOIN pools p ON p.pool_id = t.pool_id
      WHERE t.fee_groth IS NOT NULL AND t.confirmed = TRUE
      GROUP BY t.pool_id, p.aid1, p.aid2, p.kind, t.aid_in`,
  );
  const poolUsd = new Map<number, { pair: string; tier: number; usd: number }>();
  const tierUsd = new Map<number, number>();
  for (const r of feeRows) {
    const usd = valueUsd(prices.get(Number(r.aid_in)), r.fee) ?? 0;
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

  const srcTotal = [...bySourceUsd.values()].reduce((a, b) => a + b, 0) || 1;
  const by_source = [...bySourceUsd.entries()]
    .map(([source, usd]) => ({ source, usd, pct: (usd / srcTotal) * 100 }))
    .sort((a, b) => b.usd - a.usd);

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
