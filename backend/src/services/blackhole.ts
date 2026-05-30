import { config } from '../config.js';
import { logger } from '../logger.js';
import { q } from '../db.js';
import { getContract, type ContractResponse } from '../explorer.js';

/**
 * "Black Hole" chart series — cumulative per-asset balance locked in the
 * deposit-only BlackHole burn contract, in native (display) units, over time.
 *
 * The contract has a single method, Deposit → Env::FundsLock(aid, amount), with
 * no withdraw, so each asset's locked balance only ever grows: the cumulative
 * balance is the running sum of that asset's deposits. We read the whole history
 * live from the explorer's `contract?id=<cid>&exp_am=1` page (no DB indexing) and
 * reconcile the running totals against the contract's live Locked Funds table.
 *
 * Explorer shape quirks this fetcher handles (verified against live mainnet):
 *  - `exp_am=1` formats `amount` cells as signed, thousands-grouped decimal
 *    strings ("+60,011,001.00000000"). Every Beam asset is 8-decimal, so these
 *    are already native units — no per-asset scaling needed.
 *  - The Calls history groups a transaction's calls under {type:"group"}
 *    wrappers, nested arbitrarily deep. Only the primary (first) row of a group
 *    carries a height; sibling/nested rows inherit it.
 *  - A single transaction that makes N BlackHole calls is rendered as N
 *    byte-identical consecutive top-level entries, each redundantly listing all
 *    the deposits. We collapse consecutive identical entries before summing, or
 *    the totals multi-count (and overshoot the Locked Funds reconciliation).
 *  - Inside a group, only rows whose Cid column is empty target BlackHole; rows
 *    carrying their own cid (the originating DEX trade, the DaoVault fee skim)
 *    are other contracts' calls and are ignored.
 */

export interface BlackholeSeriesPoint { ts: number; value: number }
export interface BlackholeSeries {
  aid: number;
  label: string;
  color: string | null;
  points: BlackholeSeriesPoint[];
}
export interface BlackholeBody { series: BlackholeSeries[] }

const EMPTY: BlackholeBody = { series: [] };

function unwrap(cell: unknown): unknown {
  if (cell !== null && typeof cell === 'object' && 'value' in cell) {
    return (cell as { value: unknown }).value;
  }
  return cell;
}

function isEmptyCell(cell: unknown): boolean {
  return cell === '' || cell === null || cell === undefined;
}

// exp_am amounts are signed, thousands-grouped decimal strings, e.g.
// "+60,011,001.00000000" / "-3,000,000.00000000". Strip the sign/grouping and
// parse straight to native units.
function parseAmount(raw: unknown): number {
  const n = Number(String(unwrap(raw)).replace(/[+,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

interface FlatRow { height: number | null; row: ReadonlyArray<unknown> }

// Depth-first walk of the Calls history, flattening {type:"group"} wrappers
// (which the explorer nests several levels deep) and threading the running
// height so rows with an empty Height cell inherit their group's height.
function flatten(nodes: ReadonlyArray<unknown>, inherited: number | null): FlatRow[] {
  const out: FlatRow[] = [];
  let height = inherited;
  for (const n of nodes) {
    if (n !== null && typeof n === 'object' && (n as { type?: string }).type === 'group') {
      out.push(...flatten((n as { value: unknown[] }).value, height));
    } else if (Array.isArray(n)) {
      const h = unwrap(n[0]);
      if (typeof h === 'number' && Number.isFinite(h)) height = h;
      else if (typeof h === 'string' && h !== '' && Number.isFinite(Number(h))) height = Number(h);
      out.push({ height, row: n });
    }
  }
  return out;
}

interface Deposit { height: number; aid: number; amount: number }

// Columns (positional): 0 Height, 1 Cid, 2 Kind, 3 Method, 4 Args, 5 Funds, …
function extractDeposits(callRows: ReadonlyArray<unknown>): Deposit[] {
  // Collapse consecutive byte-identical top-level entries first (see file
  // header) — the per-call duplicates list every deposit, so naive summing
  // multi-counts. Same-height entries with *different* funds are genuinely
  // distinct and survive (their serialisations differ).
  const deduped: unknown[] = [];
  let prevKey: string | null = null;
  for (const r of callRows) {
    const key = JSON.stringify(r);
    if (key !== prevKey) deduped.push(r);
    prevKey = key;
  }

  const deposits: Deposit[] = [];
  for (const { height, row } of flatten(deduped, null)) {
    if (height == null) continue;
    if (unwrap(row[3]) !== 'Deposit') continue;
    if (!isEmptyCell(row[1])) continue; // non-empty Cid → another contract's call
    const funds = row[5];
    if (funds === null || typeof funds !== 'object' || (funds as { type?: string }).type !== 'table') continue;
    for (const fr of (funds as { value: ReadonlyArray<ReadonlyArray<unknown>> }).value) {
      const aid = unwrap(fr[0]);
      if (typeof aid !== 'number') continue;
      deposits.push({ height, aid, amount: parseAmount(fr[1]) });
    }
  }
  return deposits;
}

// Map heights → unix ts via block_metrics (per-block, canonical after backfill),
// falling back to block_timestamps for any height the metrics backfill hasn't
// reached yet — same COALESCE pattern as the Confidential Assets chart.
async function heightTimestamps(heights: number[]): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  if (heights.length === 0) return map;
  const { rows } = await q<{ height: string; ts: string | null }>(
    `SELECT h AS height,
            EXTRACT(epoch FROM COALESCE(
              (SELECT block_ts FROM block_metrics    WHERE height = h ORDER BY block_ts DESC LIMIT 1),
              (SELECT ts       FROM block_timestamps WHERE height = h ORDER BY ts       DESC LIMIT 1)
            ))::bigint AS ts
       FROM unnest($1::bigint[]) AS h`,
    [heights],
  );
  for (const r of rows) if (r.ts != null) map.set(Number(r.height), Number(r.ts));
  return map;
}

async function chainHeadTs(fallback: number): Promise<number> {
  const { rows } = await q<{ ts: string | null }>(
    'SELECT EXTRACT(epoch FROM MAX(block_ts))::bigint AS ts FROM block_metrics',
  );
  const ts = rows[0]?.ts;
  return ts != null ? Number(ts) : fallback;
}

async function assetMeta(aids: number[]): Promise<Map<number, { label: string; color: string | null }>> {
  const map = new Map<number, { label: string; color: string | null }>();
  if (aids.length === 0) return map;
  const { rows } = await q<{ aid: string; label: string | null; color: string | null }>(
    `SELECT aid,
            COALESCE(NULLIF(short_name, ''), NULLIF(unit_name, ''), NULLIF(name, '')) AS label,
            color
       FROM assets
      WHERE aid = ANY($1::bigint[])`,
    [aids],
  );
  for (const r of rows) map.set(Number(r.aid), { label: r.label ?? '', color: r.color });
  return map;
}

// Live Locked Funds snapshot from the same response — the reconciliation target.
function lockedFunds(res: ContractResponse): Map<number, number> {
  const map = new Map<number, number>();
  const table = res['Locked Funds'];
  if (!table?.value) return map;
  for (const r of table.value.slice(1)) {
    if (!Array.isArray(r)) continue;
    const aid = unwrap(r[0]);
    if (typeof aid === 'number') map.set(aid, parseAmount(r[1]));
  }
  return map;
}

// Walk the (small, deposit-only) Calls history. A single fetch covers the whole
// history today; the loop follows `more.hMax` defensively in case the explorer
// ever paginates it. The first response also carries the head-state Locked Funds.
async function fetchHistory(cid: string): Promise<{ rows: unknown[]; head: ContractResponse }> {
  const all: unknown[] = [];
  let head: ContractResponse | null = null;
  let hMax: number | undefined;
  for (let page = 0; page < 50; page += 1) {
    const res = await getContract(
      hMax === undefined
        ? { id: cid, exp_am: true, nMaxTxs: 100_000 }
        : { id: cid, exp_am: true, nMaxTxs: 100_000, hMax },
    );
    if (!head) head = res;
    const table = res['Calls history'];
    if (table?.value) all.push(...table.value.slice(1));
    const more = (table as { more?: { hMax?: number } } | undefined)?.more
      ?? (res as { more?: { hMax?: number } }).more;
    const next = more?.hMax;
    if (next == null || next === hMax) break;
    hMax = next;
  }
  return { rows: all, head: head ?? ({} as ContractResponse) };
}

export async function fetchBlackholeSeries(): Promise<BlackholeBody> {
  const cid = config.BLACKHOLE_CID;
  if (!cid) return EMPTY;

  const t0 = Date.now();
  const { rows, head } = await fetchHistory(cid);
  const deposits = extractDeposits(rows);
  if (deposits.length === 0) return EMPTY;

  // Sum deposits per (asset, height) → one chart point per asset per height.
  const perAid = new Map<number, Map<number, number>>();
  for (const d of deposits) {
    let byHeight = perAid.get(d.aid);
    if (!byHeight) { byHeight = new Map(); perAid.set(d.aid, byHeight); }
    byHeight.set(d.height, (byHeight.get(d.height) ?? 0) + d.amount);
  }

  const heights = [...new Set(deposits.map((d) => d.height))];
  const [tsByHeight, meta] = await Promise.all([
    heightTimestamps(heights),
    assetMeta([...perAid.keys()]),
  ]);
  let maxTs = 0;
  for (const ts of tsByHeight.values()) if (ts > maxTs) maxTs = ts;
  const headTs = await chainHeadTs(maxTs);

  const totals = new Map<number, number>();
  const series: BlackholeSeries[] = [];
  for (const [aid, byHeight] of perAid) {
    const points: BlackholeSeriesPoint[] = [];
    let cum = 0;
    for (const h of [...byHeight.keys()].sort((a, b) => a - b)) {
      cum += byHeight.get(h)!;
      const ts = tsByHeight.get(h);
      if (ts == null) { logger.warn({ aid, height: h }, 'blackhole: no timestamp for deposit height'); continue; }
      // Distinct heights normally yield distinct ts; collapse the rare equal-ts
      // collision so lightweight-charts sees a strictly-ascending series.
      const last = points[points.length - 1];
      if (last && last.ts === ts) last.value = cum;
      else points.push({ ts, value: cum });
    }
    if (points.length === 0) continue;
    totals.set(aid, cum);
    // Extend the step line to the chain head so it reaches the chart's right edge.
    const last = points[points.length - 1]!;
    if (headTs > last.ts) points.push({ ts: headTs, value: cum });
    const m = meta.get(aid);
    series.push({ aid, label: m?.label || `#${aid}`, color: m?.color ?? null, points });
  }

  // Reconcile running totals against the live Locked Funds — the built-in
  // correctness check. A mismatch means the attribution/dedup assumptions
  // drifted; log loudly but still serve the (best-effort) series.
  const locked = lockedFunds(head);
  const mismatches: string[] = [];
  for (const aid of new Set([...totals.keys(), ...locked.keys()])) {
    const got = totals.get(aid) ?? 0;
    const exp = locked.get(aid) ?? 0;
    if (Math.abs(got - exp) > Math.max(1e-6, Math.abs(exp) * 1e-9)) {
      mismatches.push(`aid ${aid}: summed ${got} vs locked ${exp}`);
    }
  }
  if (mismatches.length > 0) {
    logger.warn({ mismatches }, 'blackhole: deposit totals do not reconcile with Locked Funds');
  }

  // Biggest current balance first, so the legend leads with the assets that
  // dominate the (log-scale) plot.
  series.sort((a, b) => (b.points[b.points.length - 1]!.value) - (a.points[a.points.length - 1]!.value));

  logger.info({ series: series.length, deposits: deposits.length, ms: Date.now() - t0 }, 'blackhole series built');
  return { series };
}
