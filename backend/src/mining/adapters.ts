// Per-family normalizers. Each takes a pool's raw /api/stats JSON and returns a
// common PoolStats, or null if the payload is missing/unparseable. Never throws.
//
// Verified against live endpoints on 2026-06-29:
//   open-ethereum-pool (2miners):         top-level hashrate/minersTotal/workersTotal,
//                                         stats.lastBlockFound (unix s), nodes[0].height,
//                                         no config block exposed.
//   cryptonote-nodejs-pool (herominers):  pool.{hashrate,miners,workers}, config.fee,
//                                         config.minPaymentThreshold (groths),
//                                         lastblock.{height,timestamp}, pool.blocks[].
import type { AdapterKind } from './pools.js';

export interface PoolStats {
  hashrate: number | null;       // Sol/s
  miners: number | null;
  workers: number | null;
  blocks24h: number | null;
  lastBlockHeight: number | null;
  lastBlockTs: number | null;    // unix seconds
  fee: number | null;            // percent
  minPayout: number | null;      // BEAM
}

// Coerce a possibly-string numeric to a finite number, else null.
function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

// Plausible BEAM block height: above 1e6 (DEX-era) and below 1e8 — excludes
// share counts (small) and unix timestamps (~1.78e9) that could appear if a
// pool's response format drifts.
function isPlausibleHeight(h: number | null): h is number {
  return h !== null && h > 1_000_000 && h < 100_000_000;
}

// BEAM has 8 decimals (groths). minPaymentThreshold is reported in groths.
function grothsToBeam(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : n / 1e8;
}

export function statsUrl(baseUrl: string, kind: AdapterKind): string {
  switch (kind) {
    case 'open-eth':
    case 'cryptonote-node':
      return `${baseUrl}/api/stats`;
    case 'sunpool':
      // No JSON API. Sun Pool exposes a plaintext stats page (the same source
      // miningpoolstats scrapes); fromSunpoolText() parses it.
      return `${baseUrl}/txt/pool-stats.php`;
    case 'acepool':
      // Same Sun Pool software but no /txt/ variant, and currently idle (0 Sol/s,
      // last block months ago). Left as an offline stub (normalize → null).
      return `${baseUrl}/pool-stats.php`;
    case 'cedric':
      // MiningCore-based pool. Stats at /api/pool/ (custom Django wrapper).
      return `${baseUrl}/api/pool/`;
  }
}


// open-ethereum-pool family (e.g. 2miners).
// Live shape: { hashrate, minersTotal, workersTotal, stats: { lastBlockFound },
//               nodes: [{ height, ... }], maturedTotal, immatureTotal, candidatesTotal }
// Note: no `config` object is exposed at /api/stats for this family — fee/minPayout
// cannot be extracted; those fields return null.
function fromOpenEth(raw: any): PoolStats | null {
  if (!raw || typeof raw !== 'object') return null;

  const hashrate = num(raw.hashrate);
  if (hashrate === null) return null; // clearly not an open-eth response

  // Last block timestamp (unix seconds) lives in stats.lastBlockFound.
  const lastBlockTs = num(raw.stats?.lastBlockFound) ?? null;

  // Block height is in nodes[0].height (string).
  const firstNode = Array.isArray(raw.nodes) && raw.nodes.length > 0 ? raw.nodes[0] : null;
  const lastBlockHeight = num(firstNode?.height) ?? null;

  // blocks24h: open-ethereum-pool does not expose a per-24h count. The maturedTotal
  // and immatureTotal are all-time counters; candidatesTotal is pending shares, not
  // found blocks. We leave this null rather than report a misleading all-time figure.
  return {
    hashrate,
    miners: num(raw.minersTotal),
    workers: num(raw.workersTotal) ?? num(raw.minersTotal),
    blocks24h: null,
    lastBlockHeight,
    lastBlockTs,
    fee: null,      // not exposed at /api/stats for this family
    minPayout: null, // not exposed at /api/stats for this family
  };
}

// cryptonote-nodejs-pool family (e.g. herominers, leafpool).
// Live shape: { pool: { hashrate, miners, workers, stats: { lastBlockFound (ms) },
//                       blocks: ["hash:ts_s:...", ...] },
//               config: { fee, minPaymentThreshold (groths), coinUnits },
//               lastblock: { height, timestamp } }
function fromCryptonoteNode(raw: any): PoolStats | null {
  if (!raw || typeof raw !== 'object') return null;

  const pool = raw.pool ?? {};
  if (typeof pool !== 'object') return null;

  const hashrate = num(pool.hashrate);
  if (hashrate === null) return null; // clearly not a cryptonote-node response

  const cfg = raw.config ?? {};

  // lastblock is the most reliable source for the latest found block metadata.
  const lastblock = raw.lastblock ?? {};
  const lastBlockHeight = num(lastblock.height) ?? null;
  const lastBlockTs = num(lastblock.timestamp) ?? null;

  // pool.blocks is an array of recently found blocks as colon-separated strings:
  // "hash:unix_ts_seconds:diff:height:...:status:reward:..."
  // Count blocks found in the last 24 hours.
  let blocks24h: number | null = null;
  if (Array.isArray(pool.blocks)) {
    const cutoff = Date.now() / 1000 - 86400;
    let count = 0;
    for (const b of pool.blocks) {
      if (typeof b === 'string') {
        const parts = b.split(':');
        const tsPart = parts[1];
        if (parts.length >= 2 && tsPart !== undefined) {
          const ts = parseFloat(tsPart);
          if (Number.isFinite(ts) && ts > cutoff) count++;
        }
      }
    }
    blocks24h = count;
  }

  return {
    hashrate,
    miners: num(pool.miners),
    workers: num(pool.workers) ?? num(pool.miners),
    blocks24h,
    lastBlockHeight,
    lastBlockTs,
    fee: num(cfg.fee),
    minPayout: grothsToBeam(cfg.minPaymentThreshold),
  };
}

// MiningCore family (cedric-crispin.com).
// Live shape: { sStatus: "OK", mResponse: {
//   pool: {
//     poolFeePercent: number,
//     paymentProcessing: { minimumPayment: number (BEAM) },
//     poolStats: { connectedMiners, poolHashrate (Sol/s) },
//     networkStats:  { blockHeight },
//     lastPoolBlockTime: ISO8601 string,
//     totalBlocks: number,
//   }
// }}
function fromMiningCore(raw: any): PoolStats | null {
  if (!raw || typeof raw !== 'object') return null;
  const resp = raw.mResponse;
  if (!resp || typeof resp !== 'object') return null;
  const pool = resp.pool;
  if (!pool || typeof pool !== 'object') return null;
  const ps = pool.poolStats;
  if (!ps || typeof ps !== 'object') return null; // not a miningcore response
  const ns = pool.networkStats ?? {};
  const pp = pool.paymentProcessing ?? {};

  const hashrate = num(ps.poolHashrate);

  // lastPoolBlockTime is ISO8601 (e.g. "2026-06-28T23:44:12.874619Z")
  let lastBlockTs: number | null = null;
  if (typeof pool.lastPoolBlockTime === 'string') {
    const ms = Date.parse(pool.lastPoolBlockTime);
    if (Number.isFinite(ms)) lastBlockTs = Math.floor(ms / 1000);
  }

  return {
    hashrate,
    miners: num(ps.connectedMiners),
    workers: num(ps.connectedMiners), // miningcore exposes miners, not workers separately
    blocks24h: null, // would require a separate /api/pool/blocks/ call; not done at stats URL
    lastBlockHeight: num(ns.blockHeight), // network tip height (last block height proxy)
    lastBlockTs,
    fee: num(pool.poolFeePercent),
    minPayout: num(pp.minimumPayment), // already in BEAM (not groths)
  };
}

// Sun Pool (sunpool.top) exposes no JSON API — only a server-rendered stats
// page. We scrape /txt/pool-stats.php (the same plaintext source miningpoolstats
// reads), strip tags, and regex out the fields. `raw` is the page text.
// hashrate uses the "1h Average" line to match what miningpoolstats displays.
// lastBlockTs/blocks24h are left null: the block list's "Server time" column is
// in the pool's local timezone, so absolute/relative times can't be derived
// reliably. lastBlockHeight (the most recent pool-found block) is unambiguous.
function fromSunpoolText(raw: unknown): PoolStats | null {
  if (typeof raw !== 'string') return null;
  const text = raw.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');

  const hr = text.match(/1h Average Hash Rate:\s*([\d,]+(?:\.\d+)?)\s*Sol\/s/i);
  if (!hr) return null; // not a Sun Pool stats page / unparseable
  const hashrate = num(hr[1]!.replace(/,/g, ''));

  const m = text.match(/Total miners connected:\s*(\d+)\s*\(\s*(\d+)\s*workers?\s*\)/i);
  const miners = m ? num(m[1]) : null;
  const workers = m ? num(m[2]) : null;

  // First data row under "Last 100 blocks mined by the pool": "<height> - <date> ..."
  const blk = text.match(/Last 100 blocks mined by the pool[\s\S]*?(\d{6,})\s*-\s*\d{4}-\d{2}-\d{2}/i);
  const lastBlockHeight = blk ? num(blk[1]) : null;

  return {
    hashrate,
    miners,
    workers,
    blocks24h: null,
    lastBlockHeight,
    lastBlockTs: null,
    fee: null,      // not shown on the stats page (miningpoolstats lists sunpool at 0%)
    minPayout: null,
  };
}

// ---------------------------------------------------------------------------
// Block-height extraction
// ---------------------------------------------------------------------------

// URL to fetch a pool's recently-found blocks, or null when no usable per-block
// list exists (the pool's blocks are then left unattributed).
export function blocksUrl(baseUrl: string, kind: AdapterKind): string | null {
  switch (kind) {
    case 'open-eth':
      return `${baseUrl}/api/blocks`;
    case 'cryptonote-node':
      // herominers /api/get_blocks serves a stale 4h-old cache — unusable for
      // recent block attribution. Heights are resolved via difficulty lookup
      // against block_metrics instead (see refresh.ts). Best-effort: difficulty
      // is near-unique per block; rare collisions may over-attribute. No extra fetch needed.
      return null;
    case 'sunpool':
      return null; // heights are parsed from the already-fetched stats text
    case 'acepool':
    case 'cedric':
      return null; // no usable per-block list
  }
}

// Extract found-block heights from a blocks response. Pure, never throws.
export function parseBlocks(kind: AdapterKind, raw: unknown): number[] {
  switch (kind) {
    case 'open-eth':        return blocksFromOpenEth(raw);
    case 'cryptonote-node': return blocksFromCryptonote(raw);
    case 'sunpool':         return blocksFromSunpoolText(raw);
    default:                return [];
  }
}

function asHeights(xs: unknown): number[] {
  if (!Array.isArray(xs)) return [];
  const out: number[] = [];
  for (const b of xs) {
    const h = num((b as any)?.height);
    if (isPlausibleHeight(h)) out.push(h);
  }
  return out;
}

function blocksFromOpenEth(raw: unknown): number[] {
  if (!raw || typeof raw !== 'object') return [];
  const r = raw as any;
  return [...asHeights(r.matured), ...asHeights(r.immature), ...asHeights(r.candidates)];
}

// herominers /api/get_blocks returns a flat JSON array that alternates between:
//   even indices: colon-delimited block-detail string
//     "hash:unix_ts_s:difficulty:shares:actual_shares:status:reward:finder:region:mode"
//   odd  indices: the block height as a bare decimal string, e.g. "3925894"
// Height fields inside the colon-delimited entries look like share-count numbers
// (~2–5M) and are NOT the chain height (~3,926,xxx). The standalone height entries
// (odd indices) are the reliable source; they are > 1,000,000 and match the chain.
function blocksFromCryptonote(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const out: number[] = [];
  for (let i = 1; i < raw.length; i += 2) {
    const entry = raw[i];
    if (typeof entry === 'string') {
      const h = num(entry.trim());
      if (isPlausibleHeight(h)) out.push(h);
    }
  }
  return out;
}

// sunpool: heights live in the already-fetched /txt/pool-stats.php text.
// Block rows look like: "3925894     - 2026-06-26 19:20:42 - ..."
function blocksFromSunpoolText(raw: unknown): number[] {
  if (typeof raw !== 'string') return [];
  const text = raw.replace(/<[^>]+>/g, ' ');
  const out: number[] = [];
  const re = /(\d{6,})\s*-\s*\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const h = num(m[1]);
    if (isPlausibleHeight(h)) out.push(h);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Difficulty extraction — used when block heights must be resolved via a DB
// lookup rather than being present in the pool's blocks response.
// ---------------------------------------------------------------------------

// Extract difficulties from a pool's already-fetched stats payload.
// For cryptonote-node (herominers): pool.blocks is an array of colon-delimited
// strings where index [2] is the block difficulty (float, e.g. 5827121.25).
// Returns a deduplicated array of finite difficulties, or [] for other adapters.
export function parseBlockDifficulties(kind: AdapterKind, raw: unknown): number[] {
  if (kind !== 'cryptonote-node') return [];
  if (!raw || typeof raw !== 'object') return [];
  const pool = (raw as any).pool;
  if (!Array.isArray(pool?.blocks)) return [];
  const seen = new Set<number>();
  for (const b of pool.blocks) {
    if (typeof b !== 'string') continue;
    const parts = b.split(':');
    const d = parts[2] !== undefined ? num(parts[2]) : null;
    if (d !== null && !seen.has(d)) seen.add(d);
  }
  return Array.from(seen);
}

// ---------------------------------------------------------------------------
export function normalize(kind: AdapterKind, raw: unknown): PoolStats | null {
  switch (kind) {
    case 'open-eth':        return fromOpenEth(raw);
    case 'cryptonote-node': return fromCryptonoteNode(raw);
    case 'sunpool':         return fromSunpoolText(raw);
    case 'acepool':         return null; // idle pool, no /txt/ endpoint — offline stub
    case 'cedric':          return fromMiningCore(raw);
  }
}
