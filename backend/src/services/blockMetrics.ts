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

/**
 * Walk a height range and persist a sample for each block. Bounded concurrency
 * to avoid hammering the explorer. Idempotent — already-stored heights are
 * skipped on conflict.
 */
export async function ingestRange(
  fromHeight: number,
  toHeight: number,
  opts: { concurrency?: number; onProgress?: (h: number) => void } = {},
): Promise<number> {
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  let inserted = 0;

  for (let base = fromHeight; base <= toHeight; base += concurrency) {
    const batch: number[] = [];
    for (let i = 0; i < concurrency && base + i <= toHeight; i++) batch.push(base + i);

    const samples = await Promise.all(batch.map((h) => sampleAtHeight(h).catch((err) => {
      logger.warn({ err: err instanceof Error ? err.message : err, height: h }, 'sample failed');
      return null;
    })));

    for (const s of samples) {
      if (s) {
        await upsertSample(s);
        inserted++;
      }
    }
    opts.onProgress?.(base + batch.length - 1);
  }
  return inserted;
}
