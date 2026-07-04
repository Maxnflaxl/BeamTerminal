// Canonical network hashrate/difficulty snapshot, computed in one place so the
// Mining page summary line (/api/mining/pools), the standalone /api/network
// endpoint, and the Health page all show the identical number.
//
// hashrate = Σ(difficulty over last N blocks) / Δt  [Sol/s, BeamHash III]
// — the time-weighted average, matching the /api/charts/hashrate convention.
// Everything derives from a single last-N-rows read of block_metrics.
import { q } from '../db.js';

const WINDOW_BLOCKS = 60; // ~1h at the 60s block target

export interface RecentBlock {
  height: number;
  ts: number; // unix seconds (block_ts)
  difficulty: number;
  kernels: number;
}

export interface NetworkSnapshot {
  hashrate: number | null; // Sol/s, Σdiff/Δt over the window
  difficulty: number | null; // latest block difficulty
  avg_block_time: number | null; // seconds, Δt/(N−1) over the window
  tip_height: number | null; // MAX(height)
  recent: RecentBlock[]; // last N rows, oldest→newest
}

interface Row {
  height: string;
  ts: string;
  difficulty: number;
  kernels: number;
}

// Reads the last WINDOW_BLOCKS rows of block_metrics and derives the scalars
// from that same array — one query, no duplication of the hashrate formula.
export async function getNetworkSnapshot(): Promise<NetworkSnapshot> {
  const { rows } = await q<Row>(
    `SELECT height::text,
            EXTRACT(epoch FROM block_ts)::bigint AS ts,
            difficulty::float8 AS difficulty,
            kernels
       FROM block_metrics
      ORDER BY height DESC
      LIMIT $1`,
    [WINDOW_BLOCKS],
  );

  // rows are newest→oldest from the query; flip to oldest→newest for consumers.
  const recent: RecentBlock[] = rows
    .map((r) => ({
      height: Number(r.height),
      ts: Number(r.ts),
      difficulty: Number(r.difficulty),
      kernels: r.kernels,
    }))
    .reverse();

  if (recent.length < 2) {
    const only = recent[0] ?? null;
    return {
      hashrate: null,
      difficulty: only?.difficulty ?? null,
      avg_block_time: null,
      tip_height: only?.height ?? null,
      recent,
    };
  }

  const oldest = recent[0]!;
  const newest = recent[recent.length - 1]!;
  const span = newest.ts - oldest.ts; // seconds across the window
  const sumDiff = recent.reduce((s, b) => s + b.difficulty, 0);

  const hashrate = span > 0 ? sumDiff / span : null;
  const avgBlockTime = span > 0 ? span / (recent.length - 1) : null;

  return {
    hashrate,
    difficulty: newest.difficulty,
    avg_block_time: avgBlockTime,
    tip_height: newest.height,
    recent,
  };
}
