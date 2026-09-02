import { getBlock } from '../explorer.js';
import { q } from '../db.js';
import { logger } from '../logger.js';

// In-process LRU-ish cache. Bounded; oldest entries evicted on overflow.
const MAX_MEMORY_CACHE = 10_000;
const memory = new Map<number, Date>();

function memoryGet(height: number): Date | undefined {
  const v = memory.get(height);
  if (v !== undefined) {
    // Reinsert to mark as recent (Map preserves insertion order).
    memory.delete(height);
    memory.set(height, v);
  }
  return v;
}

function memorySet(height: number, ts: Date): void {
  if (memory.has(height)) memory.delete(height);
  memory.set(height, ts);
  while (memory.size > MAX_MEMORY_CACHE) {
    const oldest = memory.keys().next().value;
    if (oldest === undefined) break;
    memory.delete(oldest);
  }
}

/**
 * Drops every in-memory entry above `height`. Called by the reorg rewind
 * alongside its `DELETE FROM block_timestamps WHERE height > $1`, so a
 * timestamp cached from the orphaned branch can't outlive the DB row and be
 * stamped onto re-ingested rows.
 */
export function invalidateBlockTsAbove(height: number): void {
  for (const h of memory.keys()) {
    if (h > height) memory.delete(h);
  }
}

async function dbGet(height: number): Promise<Date | null> {
  const { rows } = await q<{ ts: Date }>(
    'SELECT ts FROM block_timestamps WHERE height = $1',
    [height],
  );
  return rows[0]?.ts ?? null;
}

/**
 * Inserts the row, or — when it already exists without a hash (written before
 * hashes were recorded) — fills the hash in. An existing hash is never
 * overwritten: a row that survives a reorg rewind is on the active chain by
 * construction, and the rewind deletes every row past the ancestor.
 */
async function dbPut(height: number, ts: Date, hashHex?: string): Promise<void> {
  const hash = hashHex ? Buffer.from(hashHex, 'hex') : null;
  await q(
    `INSERT INTO block_timestamps (height, ts, hash) VALUES ($1, $2, $3)
     ON CONFLICT (height) DO UPDATE SET hash = EXCLUDED.hash
       WHERE block_timestamps.hash IS NULL AND EXCLUDED.hash IS NOT NULL`,
    [height, ts, hash],
  );
}

/** The block hash we recorded for `height`, or null when the row is missing
 *  or predates hash recording. */
export async function getStoredBlockHash(height: number): Promise<Buffer | null> {
  const { rows } = await q<{ hash: Buffer | null }>(
    'SELECT hash FROM block_timestamps WHERE height = $1',
    [height],
  );
  return rows[0]?.hash ?? null;
}

/**
 * Seeds both caches with a timestamp (and, when known, the block hash)
 * obtained elsewhere (e.g. the head block from `/status`), so later lookups
 * for that height skip the explorer round-trip.
 */
export async function primeBlockTs(height: number, ts: Date, hashHex?: string): Promise<void> {
  memorySet(height, ts);
  await dbPut(height, ts, hashHex).catch((err) =>
    logger.warn({ err: err instanceof Error ? err.message : err, height }, 'block_ts cache write failed'),
  );
}

/**
 * Returns the wall-clock timestamp of the given block height.
 *
 * Lookup order: in-memory cache → DB cache → explorer `/block?height=N`.
 * On explorer fallback, the value (with the block's hash) is back-filled into
 * both caches.
 */
export async function getBlockTs(height: number): Promise<Date> {
  const cached = memoryGet(height);
  if (cached) return cached;

  const dbHit = await dbGet(height);
  if (dbHit) {
    memorySet(height, dbHit);
    return dbHit;
  }

  const block = await getBlock({ height });
  if (!block.found || block.timestamp === undefined) {
    throw new Error(`block ${height} not found on chain (or no timestamp)`);
  }
  const ts = new Date(block.timestamp * 1000);
  memorySet(height, ts);
  await dbPut(height, ts, block.hash).catch((err) =>
    // Cache write failure is non-fatal; we still have the value in memory.
    logger.warn({ err: err instanceof Error ? err.message : err, height }, 'block_ts cache write failed'),
  );
  return ts;
}

/**
 * Bulk-resolve a set of heights. Uses the same single-block endpoint per miss,
 * with concurrency=4 to avoid hammering the explorer. Returns a Map for
 * convenient lookup by callers walking many rows.
 */
export async function getBlockTsMap(heights: ReadonlyArray<number>): Promise<Map<number, Date>> {
  const unique = Array.from(new Set(heights));
  const out = new Map<number, Date>();

  // Pull all already-cached values up front.
  const remaining: number[] = [];
  for (const h of unique) {
    const cached = memoryGet(h);
    if (cached) out.set(h, cached);
    else remaining.push(h);
  }

  // DB-cached values in one round-trip.
  if (remaining.length > 0) {
    const { rows } = await q<{ height: string; ts: Date }>(
      'SELECT height, ts FROM block_timestamps WHERE height = ANY($1::bigint[])',
      [remaining],
    );
    for (const row of rows) {
      const h = Number(row.height);
      memorySet(h, row.ts);
      out.set(h, row.ts);
    }
  }

  // Explorer-fetch the rest with bounded concurrency.
  const stillMissing = remaining.filter((h) => !out.has(h));
  const CONCURRENCY = 4;
  for (let i = 0; i < stillMissing.length; i += CONCURRENCY) {
    const batch = stillMissing.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((h) => getBlockTs(h)));
    batch.forEach((h, idx) => out.set(h, results[idx]!));
  }

  return out;
}
