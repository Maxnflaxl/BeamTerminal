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

export function normalize(kind: AdapterKind, raw: unknown): PoolStats | null {
  switch (kind) {
    case 'open-eth':        return fromOpenEth(raw);
    case 'cryptonote-node': return fromCryptonoteNode(raw);
    case 'sunpool':         return fromSunpoolText(raw);
    case 'acepool':         return null; // idle pool, no /txt/ endpoint — offline stub
    case 'cedric':          return fromMiningCore(raw);
  }
}
