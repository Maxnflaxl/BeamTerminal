import { config } from '../config.js';
import { logger } from '../logger.js';
import { request } from 'undici';

/**
 * Fetch per-day network statistics from the explorer's /hdrs endpoint.
 *
 * The explorer aggregates per-block columns at a configurable height step
 * (`dh`). Setting `dh=1440` ≈ one row per day at the 60s target block time.
 * We page through every available row (the explorer caps a single response
 * at ~2048 rows) and stitch the pages into one ascending series.
 *
 * Returned series are keyed by Unix timestamp (the per-row block_ts of the
 * page boundary), with one numeric value each. Two flavours per metric:
 *   - cumulative `total_*`     — pass-through of the T.* column.
 *   - delta      `daily_*`     — last-minus-prev across adjacent rows.
 *
 * Lelantus Inputs/Outputs are exposed as deltas only (the cumulative columns
 * are noisy across the protocol upgrades; daily is what users actually want).
 */

const COLS = 'TKFUBPOYZCA' as const;
const DH = 1440;
const PAGE_SIZE = 2_000;

export interface ChartPoint { ts: number; value: number }

export interface NetworkSeries {
  total_txs:           ChartPoint[];
  daily_txs:           ChartPoint[];
  total_fee_groth:     ChartPoint[];
  daily_fee_groth:     ChartPoint[];
  total_utxos:         ChartPoint[];
  total_contracts:     ChartPoint[];
  total_contract_calls:ChartPoint[];
  daily_contract_calls:ChartPoint[];
  total_mw_outputs:    ChartPoint[];
  daily_sh_inputs:     ChartPoint[];
  total_sh_inputs:     ChartPoint[];
  daily_sh_outputs:    ChartPoint[];
  total_sh_outputs:    ChartPoint[];
  total_size_bytes:    ChartPoint[];   // Size.Compressed — current chain DB size
  total_archive_bytes: ChartPoint[];   // Size.Archive — current archive size
}

export interface ExplorerRow {
  height: number;
  ts: number;
  values: Record<string, number>;
}

function parseNumber(cell: unknown): number | null {
  if (cell === null || cell === undefined) return null;
  if (typeof cell === 'number' && Number.isFinite(cell)) return cell;
  if (typeof cell === 'string') {
    const s = cell.replace(/,/g, '').trim();
    if (s === '') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof cell === 'object' && cell !== null && 'value' in cell) {
    const v = (cell as { value: unknown }).value;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
      const n = Number(v.replace(/,/g, '').trim());
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
}

async function fetchPage(
  hMax: number | undefined,
  dh: number = DH,
  nMax: number = PAGE_SIZE,
): Promise<{ rows: ExplorerRow[]; nextHMax: number | undefined }> {
  const params = new URLSearchParams({ cols: COLS, nMax: String(nMax), dh: String(dh) });
  if (hMax !== undefined) params.set('hMax', String(hMax));
  const url = `${config.EXPLORER_URL}/hdrs?${params.toString()}`;
  const { statusCode, body } = await request(url);
  if (statusCode >= 400) {
    const text = await body.text();
    throw new Error(`hdrs HTTP ${statusCode}: ${text.slice(0, 200)}`);
  }
  const data = (await body.json()) as { type?: string; value?: unknown[]; more?: { hMax: number } };
  if (data.type !== 'table' || !Array.isArray(data.value) || data.value.length < 2) {
    return { rows: [], nextHMax: undefined };
  }

  // Columns sit positionally: Height, then `COLS` in order. We parse all of them.
  const colOrder = ['h', ...COLS.split('')];
  const out: ExplorerRow[] = [];
  for (const raw of data.value.slice(1)) {
    if (!Array.isArray(raw)) continue;
    const height = parseNumber(raw[0]);
    if (height === null) continue;
    const values: Record<string, number> = {};
    let ts = 0;
    for (let i = 1; i < colOrder.length; i += 1) {
      const code = colOrder[i]!;
      const v = parseNumber(raw[i]);
      if (v === null) continue;
      if (code === 'T') ts = v;
      else values[code] = v;
    }
    if (ts === 0) continue;
    out.push({ height, ts, values });
  }
  return { rows: out, nextHMax: data.more?.hMax };
}

async function fetchAllRows(): Promise<ExplorerRow[]> {
  const all: ExplorerRow[] = [];
  let cursor: number | undefined;
  // Safety cap: explorer rows are descending; we stop when no `more.hMax` is
  // returned or we hit a sane upper bound (5000 pages × 2000 rows is well
  // beyond Beam's mainnet age at dh=1440).
  for (let i = 0; i < 50; i += 1) {
    const { rows, nextHMax } = await fetchPage(cursor);
    if (rows.length === 0) break;
    all.push(...rows);
    if (nextHMax === undefined) break;
    if (nextHMax === cursor) break; // safety: explorer would loop on itself
    cursor = nextHMax;
  }
  // Explorer returns rows descending; flip ascending for charts.
  all.sort((a, b) => a.height - b.height);
  return all;
}

function passthrough(rows: ExplorerRow[], code: string): ChartPoint[] {
  const out: ChartPoint[] = [];
  for (const r of rows) {
    const v = r.values[code];
    if (v === undefined) continue;
    out.push({ ts: r.ts, value: v });
  }
  return out;
}

function deltaSeries(rows: ExplorerRow[], code: string): ChartPoint[] {
  const out: ChartPoint[] = [];
  let prev: number | null = null;
  for (const r of rows) {
    const v = r.values[code];
    if (v === undefined) { prev = null; continue; }
    if (prev !== null) {
      out.push({ ts: r.ts, value: v - prev });
    }
    prev = v;
  }
  return out;
}

// Trailing-24h delta of a cumulative column, for hourly rows. For each row we
// find the most recent earlier row that is >= 24h behind and subtract its
// value — i.e. "how much this counter advanced over the trailing day". Points
// without a full 24h of history behind them (series warm-up) are skipped.
function trailing24hDelta(rows: ExplorerRow[], code: string): ChartPoint[] {
  const out: ChartPoint[] = [];
  let lo = 0;
  for (let hi = 0; hi < rows.length; hi += 1) {
    const row = rows[hi]!;
    const cur = row.values[code];
    if (cur === undefined) continue;
    const cutoff = row.ts - 86_400;
    // Advance lo to the last row with ts <= cutoff (the 24h-ago baseline).
    while (lo + 1 < hi && rows[lo + 1]!.ts <= cutoff) lo += 1;
    const baseRow = rows[lo]!;
    if (baseRow.ts > cutoff) continue;          // no full-24h baseline yet
    const base = baseRow.values[code];
    if (base === undefined) continue;
    out.push({ ts: row.ts, value: cur - base });
  }
  return out;
}

export async function fetchNetworkSeries(): Promise<NetworkSeries> {
  const t0 = Date.now();
  const rows = await fetchAllRows();
  const series: NetworkSeries = {
    total_txs:            passthrough(rows, 'K'),
    daily_txs:            deltaSeries(rows, 'K'),
    total_fee_groth:      passthrough(rows, 'F'),
    daily_fee_groth:      deltaSeries(rows, 'F'),
    total_utxos:          passthrough(rows, 'U'),
    total_contracts:      passthrough(rows, 'B'),
    total_contract_calls: passthrough(rows, 'P'),
    daily_contract_calls: deltaSeries(rows, 'P'),
    total_mw_outputs:     passthrough(rows, 'O'),
    daily_sh_inputs:      deltaSeries(rows, 'Y'),
    total_sh_inputs:      passthrough(rows, 'Y'),
    daily_sh_outputs:     deltaSeries(rows, 'Z'),
    total_sh_outputs:     passthrough(rows, 'Z'),
    total_size_bytes:     passthrough(rows, 'C'),
    total_archive_bytes:  passthrough(rows, 'A'),
  };
  logger.info({ rows: rows.length, ms: Date.now() - t0 }, 'network series fetched');
  return series;
}

// Hourly-resolution network series over a recent bounded window (~36 days).
// dh=60 ≈ one row per hour at the 60s target block time; a single page covers
// the window (36d ≈ 864 rows, well under the 2048 cap). total_* pass through
// the absolute cumulative column; daily_* become trailing-24h deltas so their
// "/ day" units survive the finer resolution.
const HOURLY_DH = 60;
const HOURLY_ROWS = 900; // ~37.5 days of margin over the 35d visible window

export async function fetchNetworkSeriesHourly(): Promise<NetworkSeries> {
  const t0 = Date.now();
  const { rows } = await fetchPage(undefined, HOURLY_DH, HOURLY_ROWS);
  rows.sort((a, b) => a.height - b.height);
  const series: NetworkSeries = {
    total_txs:            passthrough(rows, 'K'),
    daily_txs:            trailing24hDelta(rows, 'K'),
    total_fee_groth:      passthrough(rows, 'F'),
    daily_fee_groth:      trailing24hDelta(rows, 'F'),
    total_utxos:          passthrough(rows, 'U'),
    total_contracts:      passthrough(rows, 'B'),
    total_contract_calls: passthrough(rows, 'P'),
    daily_contract_calls: trailing24hDelta(rows, 'P'),
    total_mw_outputs:     passthrough(rows, 'O'),
    daily_sh_inputs:      trailing24hDelta(rows, 'Y'),
    total_sh_inputs:      passthrough(rows, 'Y'),
    daily_sh_outputs:     trailing24hDelta(rows, 'Z'),
    total_sh_outputs:     passthrough(rows, 'Z'),
    total_size_bytes:     passthrough(rows, 'C'),
    total_archive_bytes:  passthrough(rows, 'A'),
  };
  logger.info({ rows: rows.length, ms: Date.now() - t0 }, 'hourly network series fetched');
  return series;
}

const RES_DH: Record<'1m' | '1h' | '1d', number> = { '1m': 1, '1h': 60, '1d': 1440 };

/**
 * Windowed /hdrs fetch: page descending from `hMax` at step `dh` until the
 * oldest fetched row precedes `stopTs`, then return ascending. Tight to the
 * requested window (+caller-supplied 24h lookback for rate series) — NOT widened.
 */
export async function fetchNetworkRangeByHeight(dh: number, hMax: number, stopTs: number): Promise<ExplorerRow[]> {
  const all: ExplorerRow[] = [];
  let cursor: number | undefined = hMax;
  for (let i = 0; i < 8; i += 1) { // bound: ~8 pages of 2000 rows caps a wide dh=1 window
    const { rows, nextHMax } = await fetchPage(cursor, dh, PAGE_SIZE);
    if (rows.length === 0) break;
    all.push(...rows);
    const oldest = Math.min(...rows.map((r) => r.ts));
    if (oldest < stopTs) break;
    if (nextHMax === undefined || nextHMax === cursor) break;
    cursor = nextHMax;
  }
  all.sort((a, b) => a.height - b.height);
  return all;
}

export function resToDh(res: '1m' | '1h' | '1d'): number { return RES_DH[res]; }
