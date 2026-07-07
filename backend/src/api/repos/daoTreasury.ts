import { config } from '../../config.js';
import { q } from '../../db.js';
import { getContract } from '../../explorer.js';
import { getLatestUsdPrices, valueUsd } from '../../services/pricing.js';
import { readDaoStat, writeDaoStat } from './daoStatsCache.js';

// DaoVault treasury. Balances come from the vault's Locked Funds state (the
// authoritative on-chain holdings). Inflows come from the *nested* Deposit
// calls — the actual fee-skims into the vault — NOT the primary
// Trade/Trove/Redeem parent txs (those are the DEX/Nephrite/... contract txs
// that merely triggered the skim). Each skim's parent method identifies its
// source (DEX / Nephrite / Names / Asset Minter).

function cellNum(c: unknown): number | null {
  if (typeof c === 'number') return c;
  if (c && typeof c === 'object' && 'value' in c) {
    const n = Number(String((c as { value: unknown }).value).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(c);
  return Number.isFinite(n) ? n : null;
}

function amountGroth(c: unknown): string {
  const raw = c && typeof c === 'object' && 'value' in c ? (c as { value: unknown }).value : c;
  return String(raw).replace(/,/g, '').split('.')[0] || '0';
}

/** Fee source, from the parent method of a nested skim Deposit. */
export function sourceLabel(parentMethod: string): string {
  switch (parentMethod) {
    case 'Trade':
      return 'DEX';
    case 'Trove Modify':
    case 'Trove Open':
    case 'Redeem':
      return 'Nephrite';
    case 'Register':
    case 'Extend period':
      return 'BANS';
    case 'Create token':
      return 'BAM';
    default:
      return parentMethod;
  }
}

export interface DaoHolding {
  aid: number;
  symbol: string;
  amount: string; // groths
  value_usd: number | null;
  pct: number;
}

export interface DaoFlow {
  height: number;
  ts: string;
  method: string; // source (DEX / Nephrite / ...)
  funds: Record<string, string>;
}

export interface DaoTreasury {
  total_usd: number;
  holdings: DaoHolding[];
  value_series: { day: string; usd: number }[];
  flows: DaoFlow[];
}

interface HoldingRaw {
  aid: number;
  symbol: string;
  amount: string;
  value_usd: number | null;
}

export async function computeDaoTreasury(): Promise<DaoTreasury> {
  const cid = config.DAO_VAULT_CID;
  if (!cid) return { total_usd: 0, holdings: [], value_series: [], flows: [] };

  const prices = await getLatestUsdPrices();

  // Authoritative balances = the vault's Locked Funds state.
  const resp = await getContract({ id: cid, nMaxTxs: 0 });
  const lockedTbl = resp['Locked Funds'] as { value?: unknown[] } | undefined;
  const lockedRows = Array.isArray(lockedTbl?.value) ? lockedTbl!.value!.slice(1) : [];
  const holdingsRaw = lockedRows
    .map((row): HoldingRaw | null => {
      if (!Array.isArray(row)) return null;
      const aid = cellNum(row[0]);
      const amount = amountGroth(row[1]);
      if (aid == null || amount === '0') return null;
      const price = prices.get(aid);
      return { aid, symbol: price?.symbol ?? `aid:${aid}`, amount, value_usd: valueUsd(price, amount) };
    })
    .filter((x): x is HoldingRaw => x != null);
  const total = holdingsRaw.reduce((s, h) => s + (h.value_usd ?? 0), 0);
  const holdings: DaoHolding[] = holdingsRaw
    .map((h) => ({ ...h, pct: total > 0 && h.value_usd != null ? (h.value_usd / total) * 100 : 0 }))
    .sort((a, b) => (b.value_usd ?? 0) - (a.value_usd ?? 0));

  // Accumulated fee inflows over time (nested skim Deposits), valued at current rates.
  const { rows: dayRows } = await q<{ day: string; aid: string; delta: string }>(
    `SELECT to_char(date_trunc('day', c.block_ts), 'YYYY-MM-DD') AS day,
            (kv.key)::bigint AS aid, SUM((kv.value)::numeric)::text AS delta
       FROM contract_call_events c, jsonb_each_text(c.funds) kv
      WHERE c.cid = $1 AND c.method = 'Deposit' AND c.parent_ord IS NOT NULL
      GROUP BY 1, 2
      ORDER BY 1`,
    [cid],
  );
  const running = new Map<number, number>();
  const seriesMap = new Map<string, number>();
  for (const r of dayRows) {
    const aid = Number(r.aid);
    const dec = prices.get(aid)?.decimals ?? 8;
    running.set(aid, (running.get(aid) ?? 0) + Number(r.delta) / Math.pow(10, dec));
    let usd = 0;
    for (const [a, bal] of running) {
      const p = prices.get(a);
      if (p?.usdPerUnit != null) usd += bal * p.usdPerUnit;
    }
    seriesMap.set(r.day, usd);
  }
  const value_series = [...seriesMap.entries()].map(([day, usd]) => ({ day, usd }));

  // Recent fee-skims, newest first, tagged with their source (parent method).
  const { rows: flowRows } = await q<{ height: string; block_ts: Date; via: string; funds: Record<string, string> }>(
    `SELECT c.height, c.block_ts, p.method AS via, c.funds
       FROM contract_call_events c
       JOIN contract_call_events p ON p.cid = c.cid AND p.height = c.height AND p.ord = c.parent_ord
      WHERE c.cid = $1 AND c.method = 'Deposit' AND c.parent_ord IS NOT NULL
      ORDER BY c.height DESC, c.ord DESC
      LIMIT 50`,
    [cid],
  );
  const flows: DaoFlow[] = flowRows.map((r) => ({
    height: Number(r.height),
    ts: r.block_ts.toISOString(),
    method: sourceLabel(r.via),
    funds: r.funds,
  }));

  return { total_usd: total, holdings, value_series, flows };
}

/** Cached read; on a miss, computes live once and warms the cache. */
export async function loadDaoTreasury(): Promise<DaoTreasury> {
  const cached = await readDaoStat<DaoTreasury>('treasury');
  if (cached) return cached;
  const fresh = await computeDaoTreasury();
  await writeDaoStat('treasury', fresh);
  return fresh;
}

export interface DaoAssetHistory {
  aid: number;
  deposits_groth: string;
  withdrawals_groth: string;
  rows: { height: number; ts: string; method: string; amount: string }[];
}

/** Fee-skim history for a single asset in the vault (newest first), by source. */
export async function loadDaoTreasuryAsset(aid: number, limit: number): Promise<DaoAssetHistory> {
  const cid = config.DAO_VAULT_CID;
  const empty: DaoAssetHistory = { aid, deposits_groth: '0', withdrawals_groth: '0', rows: [] };
  if (!cid) return empty;
  const key = String(aid);
  const { rows } = await q<{ height: string; block_ts: Date; via: string; amount: string }>(
    `SELECT c.height, c.block_ts, p.method AS via, (c.funds->>$2) AS amount
       FROM contract_call_events c
       JOIN contract_call_events p ON p.cid = c.cid AND p.height = c.height AND p.ord = c.parent_ord
      WHERE c.cid = $1 AND c.method = 'Deposit' AND c.parent_ord IS NOT NULL AND c.funds ? $2
      ORDER BY c.height DESC, c.ord DESC
      LIMIT $3`,
    [cid, key, limit],
  );
  const { rows: sums } = await q<{ dep: string }>(
    `SELECT COALESCE(SUM((funds->>$2)::numeric), 0)::text AS dep
       FROM contract_call_events
      WHERE cid = $1 AND method = 'Deposit' AND parent_ord IS NOT NULL AND funds ? $2`,
    [cid, key],
  );
  return {
    aid,
    deposits_groth: sums[0]?.dep ?? '0',
    withdrawals_groth: '0',
    rows: rows.map((r) => ({ height: Number(r.height), ts: r.block_ts.toISOString(), method: sourceLabel(r.via), amount: r.amount })),
  };
}
