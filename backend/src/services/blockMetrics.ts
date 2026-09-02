import { getBlock } from '../explorer.js';
import { q } from '../db.js';
import { logger } from '../logger.js';

export interface BlockMetricsSample {
  height: number;
  block_ts: Date;
  /** Cumulative chainwork, as returned by /block.chainwork (decimal or 0x-prefixed hex). */
  chainwork: bigint;
  kernels: number;
  difficulty: number;
}

function parseChainwork(raw: unknown): bigint {
  if (typeof raw === 'bigint') return raw;
  if (typeof raw === 'number') return BigInt(Math.trunc(raw));
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (s.startsWith('0x') || s.startsWith('0X')) return BigInt(s);
    // Some explorer builds return hex without a prefix; detect by characters.
    if (/^[0-9a-fA-F]+$/.test(s) && /[a-fA-F]/.test(s)) return BigInt('0x' + s);
    return BigInt(s);
  }
  return 0n;
}

export async function sampleAtHeight(height: number): Promise<BlockMetricsSample | null> {
  const b = await getBlock({ height });
  if (!b.found || b.timestamp === undefined) return null;
  return {
    height,
    block_ts: new Date(b.timestamp * 1000),
    chainwork: parseChainwork(b.chainwork ?? '0'),
    kernels: Array.isArray(b.kernels) ? b.kernels.length : 0,
    difficulty: typeof b.difficulty === 'number' ? b.difficulty : 0,
  };
}

export async function upsertSample(s: BlockMetricsSample): Promise<void> {
  await q(
    `INSERT INTO block_metrics (height, block_ts, chainwork, kernels, difficulty)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (height, block_ts) DO NOTHING`,
    [s.height, s.block_ts, s.chainwork.toString(), s.kernels, s.difficulty],
  );
}

export async function maxIndexedHeight(): Promise<number | null> {
  const { rows } = await q<{ height: string | null }>(
    'SELECT MAX(height) AS height FROM block_metrics',
  );
  const h = rows[0]?.height;
  return h === null || h === undefined ? null : Number(h);
}

export interface IngestRangeResult {
  /** Samples written this pass. */
  inserted: number;
  /** Highest height written with no gap below it since `fromHeight`;
   *  `fromHeight - 1` when the very first height failed. */
  lastHeight: number;
}

/**
 * Walk a height range and persist a sample for each block, in height order,
 * with no gaps. Fetches run with bounded concurrency to avoid hammering the
 * explorer, but the upserts stop at the first height that fails or comes back
 * `found: false` — nothing above it is written. The caller resumes from
 * `MAX(height)`, so a hole written past a failure would never be revisited;
 * stopping keeps the table contiguous and makes the next pass retry the
 * failed height. Idempotent — already-stored heights are skipped on conflict.
 */
export async function ingestRange(
  fromHeight: number,
  toHeight: number,
  opts: { concurrency?: number; onProgress?: (h: number) => void } = {},
): Promise<IngestRangeResult> {
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  let inserted = 0;
  let lastHeight = fromHeight - 1;

  for (let base = fromHeight; base <= toHeight; base += concurrency) {
    const batch: number[] = [];
    for (let i = 0; i < concurrency && base + i <= toHeight; i++) batch.push(base + i);

    const samples = await Promise.all(batch.map((h) => sampleAtHeight(h).catch((err) => {
      logger.warn({ err: err instanceof Error ? err.message : err, height: h }, 'sample failed');
      return null;
    })));

    // `samples` is in `batch` (ascending height) order; write until the
    // first gap.
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      if (!s) {
        logger.warn(
          { height: batch[i], from: fromHeight, to: toHeight, last_height: lastHeight },
          'block_metrics ingest stalled at unavailable height; retrying from it next pass',
        );
        return { inserted, lastHeight };
      }
      await upsertSample(s);
      inserted++;
      lastHeight = s.height;
    }
    opts.onProgress?.(lastHeight);
  }
  return { inserted, lastHeight };
}
