// backend/src/api/routes/search.ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BadRequest } from '../error.js';
import { getBlock, getContract } from '../../explorer.js';
import {
  classify, searchAssets, searchPools, searchDapps, searchPublishers, searchCharts, searchPages,
  searchContracts,
  type SearchItem, type SearchGroup, type SearchResponse, type SourceStatus,
} from '../repos/search.js';

const EXPLORER_TIMEOUT_MS = 700;
const CACHE_TTL_MS = 30_000;
const BANS_CID = 'af4550f1f8a6051ffeffea06e0cb978f8076fdfc2101d2273d4e62c86540bc5e';

// Tiny TTL + bounded-size cache (mirrors the historyCache pattern in
// routes/asset.ts). Keys here include arbitrary user input (block:/kernel:/
// contract:<hex>), so cap the size to avoid unbounded growth; oldest-first
// eviction is enough given the short TTL.
const CACHE_MAX = 2000;
const cache = new Map<string, { ts: number; value: unknown }>();
async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.value as T;
  const value = await fn();
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { ts: Date.now(), value });
  return value;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

const shortHex = (h: string): string => `${h.slice(0, 8)}…${h.slice(-6)}`;

async function lookupBlock(height: number): Promise<SearchItem[]> {
  const b = await cached(`block:${height}`, () => getBlock({ height }));
  if (!b.found) return [];
  return [{
    type: 'block', id: String(height),
    title: `Block #${height}`,
    subtitle: b.timestamp ? new Date(b.timestamp * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'block',
    href: `/explorer/beam?network=mainnet&type=block&height=${height}`,
    score: 100, flags: [],
  }];
}

async function lookupKernel(kernel: string): Promise<SearchItem[]> {
  const b = await cached(`kernel:${kernel}`, () => getBlock({ kernel }));
  if (!b.found) return [];
  return [{
    type: 'kernel', id: kernel,
    title: `Kernel ${shortHex(kernel)}`,
    subtitle: `in block #${b.height}`,
    href: `/explorer/beam?network=mainnet&type=block&kernel=${kernel}`,
    score: 100, flags: [],
  }];
}

async function lookupContract(cid: string): Promise<SearchItem[]> {
  // state:false + nMaxTxs:0 keeps it a cheap existence check.
  const c = await cached(`contract:${cid}`, () => getContract({ id: cid, state: false, nMaxTxs: 0 }));
  // The explorer always appends `h` (chain head) even for a non-existent CID,
  // so `kind` is the only existence signal — it's set iff the contract exists.
  // `kind` may be a string (named shader, e.g. "DEX v0") OR a {type:"blob",…}
  // object (unrecognized shader); coerce the subtitle so an object can't reach
  // React as a child.
  if (c.kind === undefined || c.kind === null) return [];
  return [{
    type: 'contract', id: cid,
    title: `Contract ${shortHex(cid)}`,
    subtitle: typeof c.kind === 'string' ? c.kind : 'smart contract',
    href: `/explorer/beam?network=mainnet&type=contract&id=${cid}`,
    score: 100, flags: [],
  }];
}

// Port of BANS.tsx:parseDomains — reads State.Domains.value rows.
interface ContractStateAny { State?: { Domains?: { value?: unknown[] } } }
function bansDomainExists(state: ContractStateAny, name: string): { owner: string; expiration: number } | null {
  const rows = state?.State?.Domains?.value;
  if (!Array.isArray(rows) || rows.length < 2) return null;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] as unknown[];
    if (!Array.isArray(r) || r.length < 3) continue;
    const rowName = typeof r[0] === 'string' ? r[0] : String(r[0] ?? '');
    if (rowName.toLowerCase() !== name.toLowerCase()) continue;
    const owner = (r[1] && typeof r[1] === 'object') ? String((r[1] as { value: unknown }).value) : String(r[1] ?? '');
    const expiration = (r[2] && typeof r[2] === 'object') ? Number((r[2] as { value: unknown }).value) : Number(r[2] ?? 0);
    return { owner, expiration };
  }
  return null;
}

async function lookupBans(name: string): Promise<SearchItem[]> {
  // One cached fetch of the whole Domains state, reused across queries.
  const state = await cached('bans:state', () => getContract({ id: BANS_CID })) as ContractStateAny;
  const hit = bansDomainExists(state, name);
  if (!hit) return [];
  return [{
    type: 'bans', id: name,
    title: `${name}.beam`,
    subtitle: `owner ${shortHex(hit.owner)}`,
    // Deep-link into the BANS explorer pre-filtered to this name (its domain
    // list does a case-insensitive substring match on ?q=).
    href: `/explorer/bans?q=${encodeURIComponent(name)}`,
    score: 100, flags: [],
  }];
}

const Query = z.object({
  q: z.string().trim().min(1).max(128),
});

// Stable display order + labels for groups.
const GROUP_ORDER: { type: SearchItem['type']; label: string }[] = [
  { type: 'page', label: 'Pages' },
  { type: 'asset', label: 'Assets' },
  { type: 'pool', label: 'Pools' },
  { type: 'dapp', label: 'DApps' },
  { type: 'publisher', label: 'Publishers' },
  { type: 'block', label: 'Blocks' },
  { type: 'kernel', label: 'Kernels' },
  { type: 'contract', label: 'Contracts' },
  { type: 'bans', label: 'BANS domains' },
  { type: 'chart', label: 'Charts' },
  { type: 'ipfs', label: 'IPFS' },
];

export async function searchRoutes(app: FastifyInstance): Promise<void> {
  app.get('/search', async (req, reply) => {
    const parsed = Query.safeParse(req.query);
    if (!parsed.success) throw BadRequest('BAD_QUERY', 'q must be 1–128 chars');
    const queryStr = parsed.data.q;
    const c = classify(queryStr);

    // DB lookups (fast) — settle all, never throw.
    const dbTasks: Promise<SearchItem[]>[] = [
      searchAssets(c), searchPools(c), searchDapps(c), searchPublishers(c),
    ];
    // Explorer lookups (slow) — only fire the ones the shape warrants, each timeout-bounded.
    const exTasks: Promise<SearchItem[]>[] = [];
    if (c.numeric !== null) exTasks.push(withTimeout(lookupBlock(c.numeric), EXPLORER_TIMEOUT_MS));
    if (c.hex64 !== null) {
      exTasks.push(withTimeout(lookupKernel(c.hex64), EXPLORER_TIMEOUT_MS));
      exTasks.push(withTimeout(lookupContract(c.hex64), EXPLORER_TIMEOUT_MS));
    }
    if (c.bansName !== null) exTasks.push(withTimeout(lookupBans(c.bansName), EXPLORER_TIMEOUT_MS));

    const [dbResults, exResults] = await Promise.all([
      Promise.allSettled(dbTasks),
      Promise.allSettled(exTasks),
    ]);

    const items: SearchItem[] = [];
    let dbStatus: SourceStatus = 'ok';
    for (const r of dbResults) {
      if (r.status === 'fulfilled') items.push(...r.value);
      else dbStatus = 'error';
    }
    let exStatus: SourceStatus = exTasks.length === 0 ? 'skipped' : 'ok';
    for (const r of exResults) {
      if (r.status === 'fulfilled') items.push(...r.value);
      else exStatus = r.reason instanceof Error && r.reason.message === 'timeout' ? 'timeout' : 'error';
    }

    // Network charts — static catalog, matched synchronously (no I/O).
    items.push(...searchCharts(c));

    // App pages — static catalog, matched synchronously (no I/O).
    items.push(...searchPages(c));

    // Known contracts by name — static catalog from config, no I/O. The
    // explorer already answers CID -> name; this is the way in from the name.
    items.push(...searchContracts(c));

    // Any IPFS CID is viewable via our gateway, whether or not it's a known
    // DApp's content id. Offer the gateway link (a real resource, not an
    // in-app route) below any dapp match.
    if (c.ipfsCid) {
      items.push({
        type: 'ipfs', id: c.ipfsCid,
        title: 'View on IPFS gateway',
        subtitle: `${c.ipfsCid.slice(0, 8)}…${c.ipfsCid.slice(-6)}`,
        href: `/ipfs/${c.ipfsCid}`,
        score: 50, flags: [],
      });
    }

    const groups: SearchGroup[] = GROUP_ORDER
      .map(({ type, label }) => ({
        type, label,
        items: items.filter((it) => it.type === type).sort((a, b) => b.score - a.score),
      }))
      .filter((g) => g.items.length > 0);

    const body: SearchResponse = { query: queryStr, groups, sources: { db: dbStatus, explorer: exStatus } };
    void reply.header('cache-control', 'public, max-age=15');
    return body;
  });
}
