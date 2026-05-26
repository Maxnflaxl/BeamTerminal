/**
 * One-off: replay all Oracle2 `FeedData` calls from contract deploy to head,
 * reconstruct the per-feed state at every call, recompute the on-chain median
 * (excluding "outdated" feeds whose `last_height + validity_period < H`), and
 * seed `oracle_snapshots` with one entry at the end of every UTC day.
 *
 * Constants assume the live oracle (verified 2026-05-26):
 *   - Min Providers     = 3
 *   - Validity Period   = 220 blocks
 * If these were ever changed mid-life via `Set Settings`, the corresponding
 * window's medians may differ slightly from the on-chain values; the indexer's
 * live snapshots cover the present so any drift is bounded to history.
 *
 * Pause the indexer first so it doesn't race writes:
 *   docker compose stop indexer
 *
 * Run with:
 *   yarn tsx scripts/backfill_oracle_snapshots.ts
 *   yarn tsx scripts/backfill_oracle_snapshots.ts --from=1890070 --to=3000000
 */
import { q, shutdown } from '../src/db.js';
import { getContract, getStatus, type Row } from '../src/explorer.js';
import { logger } from '../src/logger.js';
import { config } from '../src/config.js';

const ORACLE_DEPLOY_HEIGHT = 1_890_070; // From Version History
const VALIDITY_PERIOD = 220;
const MIN_PROVIDERS = 3;
const PAGE_BLOCKS = 50_000;
const MAX_CALLS = 2_000;

interface FeedDataCall {
  height: number;
  i_provider: number;
  value: number;
}

interface Snapshot {
  ts: Date;
  height: number;
  beam_usd: number;
  h_end: number;
}

function parseArg(name: string): number | undefined {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!arg) return undefined;
  const n = Number(arg.split('=')[1]);
  return Number.isFinite(n) ? n : undefined;
}

function pickString(cell: unknown): string | null {
  if (typeof cell === 'string') return cell;
  if (typeof cell === 'object' && cell !== null && 'value' in cell) {
    const v = (cell as { value: unknown }).value;
    return typeof v === 'string' ? v : null;
  }
  return null;
}

function pickNumber(cell: unknown): number | null {
  if (typeof cell === 'number' && Number.isFinite(cell)) return cell;
  if (typeof cell === 'object' && cell !== null && 'value' in cell) {
    const v = (cell as { value: unknown }).value;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function parseFeedDataRow(row: Row): FeedDataCall | null {
  if (!Array.isArray(row) || row.length < 5) return null;
  const height = pickNumber(row[0]);
  const method = pickString(row[3]);
  if (height === null || method !== 'FeedData') return null;
  const args = row[4];
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return null;
  const a = args as Record<string, unknown>;
  const i_provider = pickNumber(a.iProvider);
  const valueStr = pickString(a.Value);
  if (i_provider === null || valueStr === null) return null;
  const value = Number(valueStr);
  if (!Number.isFinite(value) || value <= 0) return null;
  return { height, i_provider, value };
}

async function fetchFeedDataPage(hMin: number, hMax: number): Promise<FeedDataCall[]> {
  const resp = await getContract({
    id: config.ORACLE_CID,
    state: false,
    hMin,
    hMax,
    nMaxTxs: MAX_CALLS,
  });
  const tbl = resp['Calls history'];
  if (!tbl || tbl.type !== 'table') return [];

  const out: FeedDataCall[] = [];
  let raw = 0;
  for (const entry of tbl.value.slice(1)) {
    raw++;
    const row = Array.isArray(entry) ? (entry as Row) : null;
    if (!row) continue;
    const fd = parseFeedDataRow(row);
    if (fd) out.push(fd);
  }
  // Detect cap-hit so we can split.
  if (raw >= MAX_CALLS && hMax > hMin) {
    const mid = Math.floor((hMin + hMax) / 2);
    logger.info({ hMin, hMax, raw, split_at: mid }, 'oracle page hit cap; splitting');
    const [a, b] = await Promise.all([
      fetchFeedDataPage(hMin, mid),
      fetchFeedDataPage(mid + 1, hMax),
    ]);
    return a.concat(b);
  }
  return out;
}

function medianOfActive(
  feeds: Map<number, { value: number; height: number }>,
  atHeight: number,
): { value: number; h_end: number } | null {
  const active: number[] = [];
  let h_end = 0;
  for (const f of feeds.values()) {
    if (f.height + VALIDITY_PERIOD >= atHeight) {
      active.push(f.value);
      if (f.height > h_end) h_end = f.height;
    }
  }
  if (active.length < MIN_PROVIDERS) return null;
  active.sort((a, b) => a - b);
  const mid = Math.floor(active.length / 2);
  const value =
    active.length % 2 === 1 ? active[mid]! : (active[mid - 1]! + active[mid]!) / 2;
  return { value, h_end };
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function endOfUtcDay(d: Date): Date {
  return new Date(d.getTime() + 86_400_000 - 1_000);
}

function nextUtcDay(d: Date): Date {
  return new Date(d.getTime() + 86_400_000);
}

async function upsertSnapshots(snaps: Snapshot[]): Promise<void> {
  if (snaps.length === 0) return;
  const CHUNK = 1_000;
  for (let i = 0; i < snaps.length; i += CHUNK) {
    const slice = snaps.slice(i, i + CHUNK);
    const placeholders: string[] = [];
    const params: (string | number | Date)[] = [];
    let p = 1;
    for (const s of slice) {
      placeholders.push(`($${p++}, $${p++}, $${p++}, $${p++})`);
      params.push(s.ts, s.height, s.beam_usd.toFixed(8), s.h_end);
    }
    await q(
      `INSERT INTO oracle_snapshots (ts, height, beam_usd, h_end)
       VALUES ${placeholders.join(', ')}
       ON CONFLICT (ts) DO NOTHING`,
      params,
    );
  }
}

async function main(): Promise<void> {
  const headStatus = await getStatus();
  const cliFrom = parseArg('from');
  const cliTo = parseArg('to');
  const start = cliFrom ?? ORACLE_DEPLOY_HEIGHT;
  const end = cliTo ?? headStatus.height;

  logger.info({ start, end }, 'oracle snapshot backfill starting');

  // Step 1: page through every FeedData call.
  const allCalls: FeedDataCall[] = [];
  const t0 = Date.now();
  for (let hMin = start; hMin <= end; hMin += PAGE_BLOCKS + 1) {
    const hMax = Math.min(hMin + PAGE_BLOCKS, end);
    const calls = await fetchFeedDataPage(hMin, hMax);
    allCalls.push(...calls);
    const pct = ((hMax - start) / (end - start)) * 100;
    logger.info(
      { hMin, hMax, calls: calls.length, total: allCalls.length, pct: +pct.toFixed(1) },
      'oracle page fetched',
    );
  }
  logger.info({ calls: allCalls.length, elapsed_s: +((Date.now() - t0) / 1000).toFixed(1) }, 'fetch phase complete');

  // Sort ascending by height to replay in order.
  allCalls.sort((a, b) => a.height - b.height);

  // Step 2: resolve block timestamps via block_metrics (which has every block
  // since chain genesis after the block-metrics backfill ran). One DB query
  // beats 150k explorer round-trips that getBlockTsMap would otherwise need.
  const heights = Array.from(new Set(allCalls.map((c) => c.height)));
  logger.info({ unique_heights: heights.length }, 'resolving block timestamps from block_metrics');
  const tsMap = new Map<number, Date>();
  const CHUNK = 50_000;
  for (let i = 0; i < heights.length; i += CHUNK) {
    const slice = heights.slice(i, i + CHUNK);
    const { rows } = await q<{ height: string; block_ts: Date }>(
      'SELECT height, block_ts FROM block_metrics WHERE height = ANY($1::bigint[])',
      [slice],
    );
    for (const r of rows) tsMap.set(Number(r.height), r.block_ts);
  }
  logger.info({ resolved: tsMap.size, missing: heights.length - tsMap.size }, 'block timestamps resolved');

  // Step 3: walk calls, maintain feed state, emit one snapshot per UTC day
  // at the EOD timestamp with the median valid at the day's last call.
  // Carry forward across days with no calls; stop at yesterday UTC.
  const feeds = new Map<number, { value: number; height: number }>();
  const today = startOfUtcDay(new Date());
  const yesterday = new Date(today.getTime() - 86_400_000);

  const dailyState = new Map<number, { ts: Date; height: number; beam_usd: number; h_end: number }>();
  // Track the latest (height, value, h_end) we computed across all calls, used
  // to carry-forward through quiet days.
  let lastValid: { height: number; value: number; h_end: number } | null = null;

  for (const call of allCalls) {
    feeds.set(call.i_provider, { value: call.value, height: call.height });
    const m = medianOfActive(feeds, call.height);
    if (!m) continue;
    lastValid = { height: call.height, value: m.value, h_end: m.h_end };

    const ts = tsMap.get(call.height);
    if (!ts) continue;
    const day = startOfUtcDay(ts);
    if (day.getTime() > yesterday.getTime()) continue;
    dailyState.set(day.getTime(), {
      ts: endOfUtcDay(day),
      height: call.height,
      beam_usd: m.value,
      h_end: m.h_end,
    });
  }

  if (dailyState.size === 0) {
    logger.warn('no daily snapshots produced — oracle has no FeedData history?');
    return;
  }

  // Build a continuous daily series with carry-forward.
  const dayKeys = Array.from(dailyState.keys()).sort((a, b) => a - b);
  const firstDay = new Date(dayKeys[0]!);
  const out: Snapshot[] = [];
  let cursor = firstDay;
  let lastSnap = dailyState.get(cursor.getTime())!;
  while (cursor.getTime() <= yesterday.getTime()) {
    const existing = dailyState.get(cursor.getTime());
    if (existing) {
      lastSnap = existing;
    }
    out.push({
      ts: endOfUtcDay(cursor),
      height: lastSnap.height,
      beam_usd: lastSnap.beam_usd,
      h_end: lastSnap.h_end,
    });
    cursor = nextUtcDay(cursor);
  }

  logger.info({ snapshots: out.length, first_day: firstDay.toISOString(), last_day: yesterday.toISOString() }, 'writing daily snapshots');
  await upsertSnapshots(out);
  logger.info({ snapshots: out.length, calls: allCalls.length, last_valid_height: lastValid?.height ?? null }, 'oracle backfill complete');
}

main()
  .catch((err) => {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'fatal');
    process.exitCode = 1;
  })
  .finally(() => shutdown());
