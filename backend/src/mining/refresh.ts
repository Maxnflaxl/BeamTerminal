// Polls every registry pool's stats API concurrently and upserts one snapshot
// row per pool. Each pool is independent: a timeout/parse failure yields null
// live fields (logged at warn) and never aborts the others. Called by the
// indexer on each new block height (inflight-gated there).
import { POOLS } from './pools.js';
import { normalize, statsUrl, blocksUrl, parseBlocks, parseBlockDifficulties } from './adapters.js';
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

      // Sync found-block heights — isolated: a failure never aborts the snapshot or other pools.
      try {
        let heights: number[];
        if (p.adapter === 'cryptonote-node') {
          // herominers /api/get_blocks serves a stale 4h cache. Instead, extract
          // difficulties from the already-fetched stats payload and resolve heights
          // via a single block_metrics lookup (difficulty uniquely maps to height).
          const diffs = parseBlockDifficulties(p.adapter, raw);
          if (diffs.length > 0) {
            interface DiffRow { difficulty: number; height: string }
            const { rows: diffRows } = await q<DiffRow>(
              `SELECT difficulty::float8 AS difficulty, height
                 FROM block_metrics
                WHERE difficulty = ANY($1::float8[])`,
              [diffs],
            );
            heights = diffRows.map((r) => Number(r.height));
          } else {
            heights = [];
          }
        } else if (p.adapter === 'sunpool') {
          // Heights are embedded in the already-fetched stats text — no extra request.
          heights = parseBlocks(p.adapter, raw);
        } else {
          const bUrl = blocksUrl(p.baseUrl, p.adapter);
          if (bUrl === null) {
            heights = [];
          } else {
            const braw = await fetchPoolRaw(bUrl);
            heights = braw !== null ? parseBlocks(p.adapter, braw) : [];
          }
        }
        if (heights.length > 0) {
          // Build a multi-row VALUES insert to avoid N round-trips.
          const values: (string | number)[] = [];
          const placeholders: string[] = [];
          heights.forEach((h, i) => {
            values.push(p.id, h);
            placeholders.push(`($${i * 2 + 1},$${i * 2 + 2})`);
          });
          await q(
            `INSERT INTO mining_pool_blocks (pool_id, height)
             VALUES ${placeholders.join(',')}
             ON CONFLICT (pool_id, height) DO NOTHING`,
            values,
          );
        }
      } catch (err) {
        logger.warn({ pool: p.id, err }, 'mining pool blocks sync failed');
      }
    }),
  );

  logger.info({ ok, failed, pools: POOLS.length }, 'mining pools refresh');
  return { ok, failed };
}
