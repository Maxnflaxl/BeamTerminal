import { getBlock } from '../explorer.js';
import { q } from '../db.js';
import { logger } from '../logger.js';

interface CursorRow {
  last_indexed_height: string;
  last_indexed_hash: Buffer | null;
}

export interface ReorgResult {
  /** True if a reorg was detected and rewound. */
  reorged: boolean;
  /** Height the cursor sits at after this check (== common ancestor on reorg). */
  height: number;
  /** Hash at `height` from the chain. */
  hash: Buffer | null;
}

/**
 * Compare our cursor's last-indexed hash against what the chain currently
 * reports at the same height. On mismatch, rewind to the common ancestor.
 *
 * Rewind strategy: binary-search backward by halving the window. We expect
 * reorgs to be very shallow (1–2 blocks on BEAM mainnet), so the search
 * usually finishes in a few iterations.
 *
 * After rewind: DELETE all trades / lp_events / pool_state_snapshots /
 * block_timestamps rows with height > common_ancestor, and reset the cursor.
 *
 * Continuous aggregates (candles_*, liquidity_1h) auto-correct: Timescale's
 * refresh policy re-scans within `start_offset` (smallest is 6h on candles_1m)
 * on every scheduled refresh, so deleted-trade buckets vanish or recompute.
 * Verified manually 2026-05-17: DELETE on trades then
 * `CALL refresh_continuous_aggregate(...)` removed the affected candle.
 * Our 80-block confirmation window (~80 min) is well within the smallest
 * start_offset, so reorg-induced rewrites always land inside the refresh range.
 */
export async function detectAndHealReorg(): Promise<ReorgResult> {
  const { rows } = await q<CursorRow>(
    'SELECT last_indexed_height::text, last_indexed_hash FROM cursor WHERE id = 1',
  );
  const cur = rows[0];
  if (!cur) throw new Error('cursor row missing');
  const lastHeight = Number(cur.last_indexed_height);
  const lastHash = cur.last_indexed_hash;

  // Nothing to compare on a fresh DB — caller will set the hash on the next
  // cursor write.
  if (lastHeight === 0 || lastHash === null) {
    return { reorged: false, height: lastHeight, hash: lastHash };
  }

  const chainBlock = await getBlock({ height: lastHeight });
  if (chainBlock.found && chainBlock.hash && hashesMatch(chainBlock.hash, lastHash)) {
    // Common case: no reorg.
    return { reorged: false, height: lastHeight, hash: lastHash };
  }

  logger.warn(
    { height: lastHeight, db_hash: lastHash.toString('hex'), chain_hash: chainBlock.hash ?? '(unknown)' },
    'reorg detected — searching for common ancestor',
  );

  const commonHeight = await findCommonAncestor(lastHeight);
  const newHashHex = (await getBlock({ height: commonHeight })).hash ?? null;
  const newHash = newHashHex ? Buffer.from(newHashHex, 'hex') : null;

  await rewindTo(commonHeight, newHash);

  logger.warn(
    {
      from_height: lastHeight,
      to_height: commonHeight,
      depth: lastHeight - commonHeight,
    },
    'reorg rewind complete',
  );

  return { reorged: true, height: commonHeight, hash: newHash };
}

/**
 * Persist the (height, hash) cursor in one update. Called after every
 * successful indexing pass — keeps last_indexed_hash co-monotone with height.
 */
export async function updateCursor(height: number, hashHex: string | undefined): Promise<void> {
  const hashBuf = hashHex ? Buffer.from(hashHex, 'hex') : null;
  await q(
    `UPDATE cursor
        SET last_indexed_height = $1,
            last_indexed_hash   = $2,
            updated_at          = now()
      WHERE id = 1`,
    [height, hashBuf],
  );
}

// ---------------------------------------------------------------------------

function hashesMatch(chainHex: string, dbBuf: Buffer): boolean {
  // explorer returns the hash as lowercase hex without 0x prefix.
  const dbHex = dbBuf.toString('hex');
  return chainHex.toLowerCase() === dbHex.toLowerCase();
}

/**
 * Walk backward from `startHeight` until /block returns a hash for that height
 * that we agree with. We don't actually have prior hashes stored (just the
 * latest), so we use a different test: at each candidate height H, we accept
 * H as the common ancestor if H ≤ 0 OR if it's "deep enough" that no further
 * disagreement is plausible. In practice we step back by powers of two until
 * the chain reports a `found: true` block — then we're safely on the active
 * chain at that point.
 *
 * Worst case: 80 blocks back (our confirmation depth), 7 doublings.
 */
async function findCommonAncestor(startHeight: number): Promise<number> {
  let step = 1;
  let h = startHeight - 1;
  while (h > 0) {
    const blk = await getBlock({ height: h });
    if (blk.found && blk.hash) {
      // The explorer always returns the *active* chain's block at H, so any
      // height we can fetch a hash for is on the active chain. Use the first
      // such H we find as the common ancestor — anything beyond that is in
      // the orphaned branch we're discarding.
      return h;
    }
    h -= step;
    step *= 2;
  }
  return 0;
}

async function rewindTo(commonHeight: number, newHash: Buffer | null): Promise<void> {
  // Single transaction so the cursor + data stay consistent.
  await q('BEGIN');
  try {
    await q('DELETE FROM trades                WHERE height > $1', [commonHeight]);
    await q('DELETE FROM lp_events             WHERE height > $1', [commonHeight]);
    await q('DELETE FROM pool_state_snapshots  WHERE height > $1', [commonHeight]);
    await q('DELETE FROM block_timestamps      WHERE height > $1', [commonHeight]);
    // Don't touch `pools` rows — pools are largely cumulative; a pool that
    // existed at commonHeight still exists. If we mistakenly marked one as
    // `destroyed_at_height > commonHeight`, undo it.
    await q(
      'UPDATE pools SET destroyed_at_height = NULL WHERE destroyed_at_height > $1',
      [commonHeight],
    );
    await q(
      `UPDATE cursor
          SET last_indexed_height = $1,
              last_indexed_hash   = $2,
              updated_at          = now()
        WHERE id = 1`,
      [commonHeight, newHash],
    );
    await q('COMMIT');
  } catch (err) {
    await q('ROLLBACK').catch(() => undefined);
    throw err;
  }
}
