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

const COLS = 'TKFUBPOYZ' as const;
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
}

interface ExplorerRow {
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

async function fetchPage(hMax: number | undefined): Promise<{ rows: ExplorerRow[]; nextHMax: number | undefined }> {
  const params = new URLSearchParams({ cols: COLS, nMax: String(PAGE_SIZE), dh: String(DH) });
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
  };
  logger.info({ rows: rows.length, ms: Date.now() - t0 }, 'network series fetched');
  return series;
}
