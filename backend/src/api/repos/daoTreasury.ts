import { config } from '../../config.js';
import { q } from '../../db.js';
import { getLatestUsdPrices, valueUsd } from '../../services/pricing.js';
import { readDaoStat, writeDaoStat } from './daoStatsCache.js';

// DaoVault treasury view, derived entirely from contract_call_events (the
// vault's Deposit/Withdraw calls carry signed per-asset funds). Balances are
// the running sum of those signed funds; USD valuation reuses services/pricing.

export interface DaoHolding {
  aid: number;
  symbol: string;
  amount: string; // groths
  value_usd: number | null;
  pct: number; // share of the priced total
}

export interface DaoFlow {
  height: number;
  ts: string;
  method: string;
  funds: Record<string, string>; // signed aid -> groths
}

export interface DaoTreasury {
  total_usd: number;
  holdings: DaoHolding[];
  value_series: { day: string; usd: number }[];
  flows: DaoFlow[];
}

export async function computeDaoTreasury(): Promise<DaoTreasury> {
  const cid = config.DAO_VAULT_CID;
  if (!cid) return { total_usd: 0, holdings: [], value_series: [], flows: [] };

  const prices = await getLatestUsdPrices();

  // Current balance per asset = cumulative signed funds across all vault calls.
  const { rows: balRows } = await q<{ aid: string; amount: string }>(
    `SELECT (kv.key)::bigint AS aid, SUM((kv.value)::numeric)::text AS amount
       FROM contract_call_events e, jsonb_each_text(e.funds) kv
      WHERE e.cid = $1 AND e.funds IS NOT NULL
      GROUP BY 1
      HAVING SUM((kv.value)::numeric) > 0`,
    [cid],
  );

  const holdingsRaw = balRows.map((r) => {
    const aid = Number(r.aid);
    const price = prices.get(aid);
    return {
      aid,
      symbol: price?.symbol ?? `aid:${aid}`,
      amount: r.amount,
      value_usd: valueUsd(price, r.amount),
    };
  });
  const total = holdingsRaw.reduce((s, h) => s + (h.value_usd ?? 0), 0);
  const holdings: DaoHolding[] = holdingsRaw
    .map((h) => ({ ...h, pct: total > 0 && h.value_usd != null ? (h.value_usd / total) * 100 : 0 }))
    .sort((a, b) => (b.value_usd ?? 0) - (a.value_usd ?? 0));

  // Value over time: cumulative daily balance per asset, valued at current
  // cross-rates. Shows the balance trajectory in today's dollars; point-in-time
  // repricing is a follow-up.
  const { rows: dayRows } = await q<{ day: string; aid: string; delta: string }>(
    `SELECT to_char(date_trunc('day', block_ts), 'YYYY-MM-DD') AS day,
            (kv.key)::bigint AS aid, SUM((kv.value)::numeric)::text AS delta
       FROM contract_call_events e, jsonb_each_text(e.funds) kv
      WHERE e.cid = $1 AND e.funds IS NOT NULL
      GROUP BY 1, 2
      ORDER BY 1`,
    [cid],
  );
  const running = new Map<number, number>(); // aid -> whole-unit balance
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

  // Recent deposits/withdrawals, newest first (primary calls only).
  const { rows: flowRows } = await q<{ height: string; block_ts: Date; method: string; funds: Record<string, string> }>(
    `SELECT height, block_ts, method, funds
       FROM contract_call_events
      WHERE cid = $1 AND funds IS NOT NULL AND parent_ord IS NULL
      ORDER BY height DESC, ord DESC
      LIMIT 50`,
    [cid],
  );
  const flows: DaoFlow[] = flowRows.map((r) => ({
    height: Number(r.height),
    ts: r.block_ts.toISOString(),
    method: r.method,
    funds: r.funds,
  }));

  return { total_usd: total, holdings, value_series, flows };
}

/** Cached read; on a miss, computes live (13-16s) once and warms the cache. */
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

/** Deposit/withdrawal history for a single asset in the vault (newest first). */
export async function loadDaoTreasuryAsset(aid: number, limit: number): Promise<DaoAssetHistory> {
  const cid = config.DAO_VAULT_CID;
  const empty: DaoAssetHistory = { aid, deposits_groth: '0', withdrawals_groth: '0', rows: [] };
  if (!cid) return empty;
  const key = String(aid);
  const { rows } = await q<{ height: string; block_ts: Date; method: string; amount: string }>(
    `SELECT height, block_ts, method, (funds->>$2) AS amount
       FROM contract_call_events
      WHERE cid = $1 AND funds ? $2
      ORDER BY height DESC, ord DESC
      LIMIT $3`,
    [cid, key, limit],
  );
  const { rows: sums } = await q<{ dep: string; wd: string }>(
    `SELECT COALESCE(SUM((funds->>$2)::numeric) FILTER (WHERE (funds->>$2)::numeric > 0), 0)::text AS dep,
            COALESCE(SUM((funds->>$2)::numeric) FILTER (WHERE (funds->>$2)::numeric < 0), 0)::text AS wd
       FROM contract_call_events
      WHERE cid = $1 AND funds ? $2`,
    [cid, key],
  );
  return {
    aid,
    deposits_groth: sums[0]?.dep ?? '0',
    withdrawals_groth: sums[0]?.wd ?? '0',
    rows: rows.map((r) => ({ height: Number(r.height), ts: r.block_ts.toISOString(), method: r.method, amount: r.amount })),
  };
}
