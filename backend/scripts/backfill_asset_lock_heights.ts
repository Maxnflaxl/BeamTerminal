/**
 * One-off: pull the current /assets registry and stamp each asset's on-chain
 * `LockHeight` (column 4 of the registry table) into `assets.lock_height`.
 * Idempotent — re-running is safe and a no-op once every asset already has
 * a non-null lock_height.
 *
 * Run via:
 *   yarn tsx scripts/backfill_asset_lock_heights.ts
 */
import { q, shutdown } from '../src/db.js';
import { getAssets } from '../src/explorer.js';
import { logger } from '../src/logger.js';

function pickAid(cell: unknown): number | null {
  if (typeof cell === 'object' && cell !== null) {
    const v = cell as { type?: unknown; value?: unknown };
    if (v.type === 'aid' && typeof v.value === 'number') return v.value;
  }
  if (typeof cell === 'number') return cell;
  return null;
}

function pickHeight(cell: unknown): number | null {
  if (typeof cell === 'number' && Number.isFinite(cell)) return cell;
  if (typeof cell === 'string') {
    const n = Number(cell);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof cell === 'object' && cell !== null) {
    const v = cell as { type?: unknown; value?: unknown };
    if (typeof v.value === 'number') return v.value;
    if (typeof v.value === 'string') {
      const n = Number(v.value);
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
}

async function main(): Promise<void> {
  const resp = await getAssets();
  if (resp.type !== 'table') throw new Error('unexpected /assets response');

  let updated = 0;
  let skipped = 0;
  for (const row of resp.value.slice(1)) {
    if (!Array.isArray(row)) continue;
    const aid = pickAid(row[0]);
    const lockHeight = pickHeight(row[4]);
    if (aid === null || aid === 0 || lockHeight === null) {
      skipped++;
      continue;
    }
    const res = await q(
      `UPDATE assets
       SET lock_height = $2
       WHERE aid = $1 AND (lock_height IS NULL OR lock_height <> $2)`,
      [aid, lockHeight],
    );
    if (res.rowCount && res.rowCount > 0) updated++;
  }
  logger.info({ updated, skipped, total: resp.value.length - 1 }, 'asset lock_height backfill done');
}

main()
  .catch((err) => {
    logger.error({ err: err instanceof Error ? err.message : err }, 'backfill failed');
    process.exitCode = 1;
  })
  .finally(() => shutdown());
