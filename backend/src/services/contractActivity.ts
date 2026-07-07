import { config } from '../config.js';
import { getContract } from '../explorer.js';
import { parseContractCallHistory } from '../parsers/contractCalls.js';
import { getBlockTsMap } from './blockTimestamps.js';
import { q } from '../db.js';
import { logger } from '../logger.js';

const MAX_CALLS_PER_PAGE = 2000;
const BACKFILL_PAGE_SIZE = 50_000;
// Bound per-tick backfill work so a large first-run backfill can't stall DEX
// ingest (mirrors block_metrics' per-tick cap). 8 pages × 50k = 400k blocks/tick.
const PAGES_PER_TICK = 8;

export interface WatchedContract {
  cid: string;
  label: string;
  deployHeight: number;
}

/** Contracts whose call history we index. Add an entry to watch another. */
export function watchedContracts(): WatchedContract[] {
  const out: WatchedContract[] = [];
  if (config.BANS_CID) {
    out.push({ cid: config.BANS_CID, label: 'bans', deployHeight: config.BANS_DEPLOY_HEIGHT });
  }
  return out;
}

async function readCursor(cid: string): Promise<number | null> {
  const { rows } = await q<{ h: string }>(
    'SELECT last_indexed_height AS h FROM contract_activity_cursor WHERE cid = $1',
    [cid],
  );
  return rows[0] ? Number(rows[0].h) : null;
}

async function writeCursor(cid: string, height: number): Promise<void> {
  await q(
    `INSERT INTO contract_activity_cursor (cid, last_indexed_height) VALUES ($1, $2)
     ON CONFLICT (cid) DO UPDATE SET last_indexed_height = EXCLUDED.last_indexed_height`,
    [cid, height],
  );
}

/**
 * Fetch [hMin, hMax] call history for `cid` and upsert into contract_call_events.
 * Mirrors services/calls.ts::indexCalls: recursive range-split on the nMaxTxs
 * cap, block_ts resolved in one pass, ON CONFLICT DO NOTHING idempotency.
 * Returns the number of rows written (before conflicts). Uses state=0 (raw groths).
 */
export async function ingestContractCallsRange(cid: string, hMin: number, hMax: number): Promise<number> {
  const resp = await getContract({ id: cid, state: false, hMin, hMax, nMaxTxs: MAX_CALLS_PER_PAGE });
  const entryCount = (resp['Calls history']?.value.length ?? 1) - 1; // minus header

  if (entryCount >= MAX_CALLS_PER_PAGE && hMax > hMin) {
    const mid = Math.floor((hMin + hMax) / 2);
    logger.info({ cid, hMin, hMax, entries: entryCount, split_at: mid }, 'contract-activity page hit cap; splitting');
    const [a, b] = await Promise.all([
      ingestContractCallsRange(cid, hMin, mid),
      ingestContractCallsRange(cid, mid + 1, hMax),
    ]);
    return a + b;
  }

  const calls = parseContractCallHistory(resp);
  if (calls.length === 0) return 0;

  const tsMap = await getBlockTsMap(calls.map((c) => c.height));
  let written = 0;
  for (const call of calls) {
    const ts = tsMap.get(call.height);
    if (!ts) { logger.warn({ cid, height: call.height }, 'no block_ts for call; skipping'); continue; }
    await q(
      `INSERT INTO contract_call_events
         (cid, height, ord, block_ts, parent_ord, target_cid, kind, method, name, args, funds)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (cid, height, ord) DO NOTHING`,
      [
        cid, call.height, call.ord, ts, call.parentOrd, call.targetCid, call.kind, call.method,
        call.name,
        call.args ? JSON.stringify(call.args) : null,
        call.funds ? JSON.stringify(call.funds) : null,
      ],
    );
    written += 1;
  }
  return written;
}

/**
 * Advance one watched contract from its cursor toward `head`, at most
 * `pageBudget` pages this call. Backfill and steady-state are the same loop:
 * once caught up, each tick ingests the tiny [cursor+1, head] tail.
 */
export async function ingestContractActivity(
  c: WatchedContract,
  head: number,
  pageBudget: number,
): Promise<{ from: number; to: number; written: number } | null> {
  const cursor = await readCursor(c.cid);
  let from = cursor ?? Math.max(c.deployHeight - 1, 0);
  if (from >= head) return null;

  const start = from;
  let pages = 0;
  let written = 0;
  while (from < head && pages < pageBudget) {
    const to = Math.min(from + BACKFILL_PAGE_SIZE, head);
    written += await ingestContractCallsRange(c.cid, from + 1, to);
    await writeCursor(c.cid, to);
    from = to;
    pages += 1;
  }
  return { from: start + 1, to: from, written };
}

/** Ingest every watched contract this tick. Inline in the indexer tick (not
 *  fire-and-forget): contract_call_events is reorg-cleaned, so a background run
 *  could race the reorg DELETE. */
export async function ingestWatchedContracts(head: number): Promise<void> {
  for (const c of watchedContracts()) {
    try {
      const res = await ingestContractActivity(c, head, PAGES_PER_TICK);
      if (res && res.written > 0) {
        logger.info({ cid: c.cid, label: c.label, ...res }, 'contract-activity ingest');
      }
    } catch (err) {
      logger.warn(
        { cid: c.cid, label: c.label, err: err instanceof Error ? err.message : err },
        'contract-activity ingest failed; will retry next tick',
      );
    }
  }
}
