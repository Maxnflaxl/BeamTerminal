/**
 * One-off: for every known asset, fetch its history from the explorer and
 * resolve block_ts for every event height that isn't already in
 * block_timestamps. Targeted approach instead of a full block resync —
 * CA mint/burn events are sparse (~few hundred unique heights across all
 * assets) so this is minutes, not hours.
 *
 * Run via:
 *   docker compose run --rm api node dist/scripts/backfill_asset_history_timestamps.js
 */
import { q, shutdown } from '../src/db.js';
import { getAssetHistory, getBlock } from '../src/explorer.js';
import { logger } from '../src/logger.js';

async function main(): Promise<void> {
  const { rows: assets } = await q<{ aid: string }>(
    `SELECT aid::text FROM assets WHERE aid > 0 ORDER BY aid ASC`,
  );
  logger.info({ count: assets.length }, 'walking assets');

  // First pass: collect all event heights from every asset's /history.
  const heights = new Set<number>();
  let assetErrors = 0;
  for (const { aid } of assets) {
    const aidN = Number(aid);
    try {
      const resp = await getAssetHistory({ id: aidN, hMin: 0, nMaxOps: 500 });
      const tbl = resp['Asset history'];
      if (!tbl || tbl.type !== 'table') continue;
      let added = 0;
      for (const row of tbl.value.slice(1)) {
        if (!Array.isArray(row)) continue;
        const cell = row[0];
        const h = typeof cell === 'number'
          ? cell
          : typeof cell === 'string'
            ? Number(cell)
            : (cell && typeof cell === 'object' && 'value' in (cell as Record<string, unknown>))
              ? Number((cell as { value: unknown }).value)
              : NaN;
        if (Number.isFinite(h) && h > 0) {
          heights.add(h);
          added++;
        }
      }
      logger.info({ aid: aidN, events: added }, 'asset history walked');
    } catch (err) {
      assetErrors++;
      logger.warn({ aid: aidN, err: err instanceof Error ? err.message : err }, 'asset history failed');
    }
  }
  logger.info({ unique_heights: heights.size, asset_errors: assetErrors }, 'collected event heights');

  if (heights.size === 0) {
    logger.info('nothing to do');
    return;
  }

  // Dedupe: only fetch /block for heights we don't already have.
  const heightArr = [...heights];
  const { rows: have } = await q<{ height: string }>(
    `SELECT height::text FROM block_timestamps WHERE height = ANY($1::bigint[])`,
    [heightArr],
  );
  const haveSet = new Set(have.map((r) => Number(r.height)));
  const missing = heightArr.filter((h) => !haveSet.has(h));
  logger.info({ have: haveSet.size, missing: missing.length }, 'block_ts gap analysis');

  if (missing.length === 0) {
    logger.info('all heights already in block_timestamps');
    return;
  }

  // Second pass: fetch /block?height=H for each missing height, batch inserts.
  let resolved = 0;
  let blockErrors = 0;
  const BATCH = 200;
  let buffer: Array<{ height: number; ts: number }> = [];
  const flush = async (): Promise<void> => {
    if (buffer.length === 0) return;
    const values: string[] = [];
    const params: Array<number | string> = [];
    buffer.forEach((b, i) => {
      values.push(`($${i * 2 + 1}, to_timestamp($${i * 2 + 2}))`);
      params.push(b.height, b.ts);
    });
    await q(
      `INSERT INTO block_timestamps (height, ts) VALUES ${values.join(', ')}
       ON CONFLICT (height) DO NOTHING`,
      params,
    );
    buffer = [];
  };

  for (const h of missing) {
    try {
      const block = await getBlock({ height: h });
      if (block.timestamp && block.timestamp > 0) {
        buffer.push({ height: h, ts: block.timestamp });
        resolved++;
      }
      if (buffer.length >= BATCH) {
        await flush();
        logger.info({ resolved, total: missing.length }, 'progress');
      }
    } catch (err) {
      blockErrors++;
      logger.warn({ height: h, err: err instanceof Error ? err.message : err }, 'block fetch failed');
    }
  }
  await flush();
  logger.info({ resolved, missing: missing.length, errors: blockErrors }, 'backfill done');
}

main()
  .catch((err) => {
    logger.error({ err: err instanceof Error ? err.message : err }, 'backfill failed');
    process.exitCode = 1;
  })
  .finally(() => shutdown());
