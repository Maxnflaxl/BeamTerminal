import { getBlock } from '../explorer.js';
import { pool, q } from '../db.js';
import { logger } from '../logger.js';
import { getStoredBlockHash, invalidateBlockTsAbove } from './blockTimestamps.js';

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
 * Rewind strategy: walk back from the cursor comparing the chain's hash at
 * each probed height against the hash we recorded in `block_timestamps`
 * (see findCommonAncestor). We expect reorgs to be very shallow (1–2 blocks
 * on BEAM mainnet), so the search usually finishes in a few iterations.
 *
 * After rewind: DELETE all trades / lp_events / pool_state_snapshots /
 * block_timestamps rows with height > common_ancestor, and reset the cursor.
 *
 * Continuous aggregates (candles_*, liquidity_1h) auto-correct: Timescale's
 * refresh policy re-scans within `start_offset` (smallest is 6h on candles_1m)
 * on every scheduled refresh, so deleted-trade buckets vanish or recompute.
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
 * True when our recorded view of height `h` is still what the chain serves.
 *
 * The explorer answers `/block?height=H` from the active chain for every
 * height at or below the tip, so `found` alone says nothing about whether
 * *our* block at H survived — only comparing hashes does. The comparison uses
 * the hash `block_timestamps` recorded when H was first fetched. Rows written
 * before hashes were recorded have none; such heights are accepted as
 * on-chain (the only test available is `found`), which bounds the rewind at
 * the oldest hash-less row instead of walking to genesis.
 */
async function isOnActiveChain(h: number): Promise<boolean> {
  const blk = await getBlock({ height: h });
  if (!blk.found || !blk.hash) return false;
  const stored = await getStoredBlockHash(h);
  if (stored === null) return true;
  return hashesMatch(blk.hash, stored);
}

/**
 * Finds the highest height at or below `startHeight - 1` whose recorded hash
 * still matches the chain.
 *
 * Phase 1 — bracket: probe `startHeight - 1`, then step back by doubling
 * offsets (1, 2, 4, …) until a probe matches. Every probe that mismatched is
 * on the orphaned branch; the first match is on the active chain, and the
 * ancestor lies in [match, previous mismatch).
 *
 * Phase 2 — bisect that bracket: the lowest probe matched and the highest
 * mismatched, so the invariant `lo matches, hi mismatches` narrows until the
 * two are adjacent, and `lo` is the exact common ancestor.
 *
 * Typical reorg (1–2 blocks): the first probe matches and phase 2 is skipped.
 * Worst case at our 80-block confirmation depth: 7 doublings + 6 bisections.
 */
async function findCommonAncestor(startHeight: number): Promise<number> {
  // `hi` is the lowest height known to be orphaned. The cursor height itself
  // is where the mismatch was detected.
  let hi = startHeight;
  let lo = -1;

  let step = 1;
  for (let h = startHeight - 1; h > 0; h -= step, step *= 2) {
    if (await isOnActiveChain(h)) {
      lo = h;
      break;
    }
    hi = h;
  }
  if (lo < 0) return 0;

  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (await isOnActiveChain(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

async function rewindTo(commonHeight: number, newHash: Buffer | null): Promise<void> {
  // Single transaction so the cursor + data stay consistent. Must run on a
  // dedicated client: pool.query() hands each statement to whichever pooled
  // connection is free, so BEGIN/COMMIT and the DELETEs would not share a
  // transaction (the tick's fire-and-forget tasks use the same pool
  // concurrently).
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM trades                WHERE height > $1', [commonHeight]);
    await client.query('DELETE FROM lp_events             WHERE height > $1', [commonHeight]);
    await client.query('DELETE FROM pool_state_snapshots  WHERE height > $1', [commonHeight]);
    // Rewound trades invalidate the daily volume materialization from the
    // ancestor's day onward; drop those rows so the next dex_stats refresh
    // recomputes them (all of them, when the ancestor's day is unknown).
    // Runs BEFORE the block_timestamps purge so the ancestor's ts is still
    // present when cached.
    await client.query(
      `DELETE FROM dex_stats_daily
        WHERE day >= COALESCE(
          (SELECT time_bucket(INTERVAL '1 day', ts) FROM block_timestamps WHERE height = $1),
          to_timestamp(0))`,
      [commonHeight],
    );
    await client.query('DELETE FROM block_timestamps      WHERE height > $1', [commonHeight]);
    // The in-process block-ts cache fronts that table; drop the same heights
    // there so a timestamp from the orphaned branch can't be served later.
    invalidateBlockTsAbove(commonHeight);
    // Watched-contract call history is height-keyed and reorg-cleaned like the
    // hot tables. Purge past the ancestor and clamp each contract's cursor so
    // the next tick re-ingests [ancestor+1, head] idempotently.
    await client.query('DELETE FROM contract_call_events  WHERE height > $1', [commonHeight]);
    await client.query('DELETE FROM dao_votes             WHERE height > $1', [commonHeight]);
    await client.query(
      `UPDATE contract_activity_cursor
          SET last_indexed_height = LEAST(last_indexed_height, $1)
        WHERE last_indexed_height > $1`,
      [commonHeight],
    );
    // Bridge messages are keyed by (bridge, chain, direction, msg_id) — a
    // natural key, so re-reading is idempotent and there's nothing to delete.
    // Blank the Beam-side provenance of anything past the ancestor and rewind
    // the cursor so the next sync re-derives it from the contract. Incoming
    // (eth2beam) rows key off Ethereum blocks, so only their Beam-side delivery
    // and claim blocks — which the next sync re-derives from the call history —
    // need clearing.
    await client.query(
      `UPDATE bridge_messages
          SET status = 'unknown', src_height = NULL, src_ts = NULL,
              src_call_height = NULL, updated_at = now()
        WHERE direction = 'beam2eth' AND src_height > $1`,
      [commonHeight],
    );
    await client.query(
      `UPDATE bridge_messages
          SET delivered_height = CASE WHEN delivered_height > $1 THEN NULL ELSE delivered_height END,
              claimed_height   = CASE WHEN claimed_height   > $1 THEN NULL ELSE claimed_height END,
              updated_at = now()
        WHERE direction = 'eth2beam'
          AND (delivered_height > $1 OR claimed_height > $1)`,
      [commonHeight],
    );
    await client.query(
      `UPDATE bridge_cursors c
          SET beam_msg_hi = COALESCE(
                (SELECT MAX(m.msg_id) FROM bridge_messages m
                  WHERE m.bridge = c.bridge AND m.direction = 'beam2eth'
                    AND m.src_height IS NOT NULL), 0),
              updated_at = now()`,
    );
    // Don't touch `pools` rows — pools are largely cumulative; a pool that
    // existed at commonHeight still exists. If we mistakenly marked one as
    // `destroyed_at_height > commonHeight`, undo it.
    await client.query(
      'UPDATE pools SET destroyed_at_height = NULL WHERE destroyed_at_height > $1',
      [commonHeight],
    );
    await client.query(
      `UPDATE cursor
          SET last_indexed_height = $1,
              last_indexed_hash   = $2,
              updated_at          = now()
        WHERE id = 1`,
      [commonHeight, newHash],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
