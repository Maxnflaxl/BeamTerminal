// Polls every registry pool's stats API concurrently and upserts one snapshot
// row per pool. Each pool is independent: a timeout/parse failure yields null
// live fields (logged at warn) and never aborts the others. Called by the
// indexer on each new block height (inflight-gated there).
import { POOLS } from './pools.js';
import { normalize, statsUrl } from './adapters.js';
import { q } from '../db.js';
import { logger } from '../logger.js';

const FETCH_TIMEOUT_MS = 8000;

async function fetchPoolRaw(url: string): Promise<unknown | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: 'application/json, text/html', 'user-agent': 'BeamTerminal/1.0' },
    });
    if (!res.ok) return null;
    // Read as text, then prefer parsed JSON. JSON pools get a parsed object;
    // HTML-scraper pools (e.g. sunpool) get the raw string for their adapter.
    const text = await res.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function refreshMiningPools(): Promise<{ ok: number; failed: number }> {
  const ts = new Date();
  let ok = 0;
  let failed = 0;

  await Promise.allSettled(
    POOLS.map(async (p) => {
      const raw = await fetchPoolRaw(statsUrl(p.baseUrl, p.adapter));
      const s = raw === null ? null : normalize(p.adapter, raw);
      if (!s) {
        failed++;
        logger.warn({ pool: p.id }, 'mining pool stats unavailable');
      } else {
        ok++;
      }
      // Always write a row (NULLs when offline) so the API/UI can show staleness.
      await q(
        `INSERT INTO mining_pool_snapshots
           (pool_id, ts, hashrate, miners, workers, blocks_24h,
            last_block_height, last_block_ts, fee, min_payout)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (pool_id, ts) DO NOTHING`,
        [
          p.id, ts,
          s?.hashrate ?? null, s?.miners ?? null, s?.workers ?? null, s?.blocks24h ?? null,
          s?.lastBlockHeight ?? null,
          s?.lastBlockTs ? new Date(s.lastBlockTs * 1000) : null,
          s?.fee ?? null, s?.minPayout ?? null,
        ],
      );
    }),
  );

  logger.info({ ok, failed, pools: POOLS.length }, 'mining pools refresh');
  return { ok, failed };
}
