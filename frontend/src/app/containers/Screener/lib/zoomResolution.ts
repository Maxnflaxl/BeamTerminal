export type ZoomRes = '1m' | '1h' | '1d';
export const BUCKET_SECONDS: Record<ZoomRes, number> = { '1m': 60, '1h': 3600, '1d': 86_400 };
export const MAX_POINTS = 2000;
export const TILE_BUCKETS = 256;

const ORDER: ZoomRes[] = ['1m', '1h', '1d']; // finest → coarsest

/** Finest bucket in `ladder` whose visible-point count stays ≤ MAX_POINTS; coarsest if none. */
export function pickResolution(spanSeconds: number, ladder: ZoomRes[]): ZoomRes {
  const avail = ORDER.filter((r) => ladder.includes(r));
  for (const r of avail) if (spanSeconds / BUCKET_SECONDS[r] <= MAX_POINTS) return r;
  return avail[avail.length - 1] ?? '1d';
}

/** Hysteresis: only switch when clearly past the boundary (±20%), else keep `current`. */
export function stickyPick(spanSeconds: number, ladder: ZoomRes[], current: ZoomRes | null): ZoomRes {
  const target = pickResolution(spanSeconds, ladder);
  if (current === null || target === current) return target;
  // If a 20% nudge toward `current` still lands on `target`, the change is decisive.
  const nudged = pickResolution(spanSeconds * (ORDER.indexOf(target) > ORDER.indexOf(current) ? 0.8 : 1.2), ladder);
  return nudged === current ? current : target;
}

/** Per-tier widen multiplier: ~1× at 1m (cheap not to over-fetch), up to 3× at 1d. */
const WIDEN: Record<ZoomRes, number> = { '1m': 1, '1h': 2, '1d': 3 };

/** Widen the window for pan-reuse, capped so span/bucket ≤ MAX_POINTS, tile-aligned. */
export function widenWindow(fromSec: number, toSec: number, res: ZoomRes): { from: number; to: number } {
  const b = BUCKET_SECONDS[res];
  const span = toSec - fromSec;
  const pad = Math.min(span * (WIDEN[res] - 1) / 2, Math.max(0, (MAX_POINTS * b - span) / 2));
  let from = fromSec - pad, to = toSec + pad;
  const tile = b * TILE_BUCKETS;
  from = Math.floor(from / tile) * tile;
  to = Math.ceil(to / tile) * tile;
  return { from: Math.max(0, Math.round(from)), to: Math.round(to) };
}

const FULL: ZoomRes[] = ['1m', '1h', '1d'];
const DAILY: ZoomRes[] = ['1d'];
export const LADDERS: Record<string, ZoomRes[]> = {
  price: FULL, tvl: FULL, hashrate: FULL, difficulty: FULL, blockTime: FULL, coinbase: FULL,
  dexVolume: FULL, assets: FULL,
  transactionsDaily: FULL, transactionsTotal: FULL, txosTotal: FULL, utxosTotal: FULL,
  sizeTotal: FULL, archiveTotal: FULL, shieldedIns: FULL, shieldedInsTotal: FULL,
  shieldedOuts: FULL, shieldedOutsTotal: FULL, contractsTotal: FULL, feesDaily: FULL, feesTotal: FULL,
  callsDaily: FULL, callsTotal: FULL,
  beamVol: DAILY, dexVol: DAILY, dexVolumeCumulative: DAILY, blackhole: DAILY,
};
