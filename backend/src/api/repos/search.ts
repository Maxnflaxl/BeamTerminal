// backend/src/api/repos/search.ts
import { q } from '../../db.js';
import { config } from '../../config.js';

export type SearchType =
  | 'asset' | 'pool' | 'dapp' | 'publisher'
  | 'block' | 'kernel' | 'contract' | 'bans' | 'chart' | 'ipfs' | 'page';

export interface SearchItem {
  type: SearchType;
  id: string;
  title: string;
  subtitle: string;
  href: string;
  score: number;       // higher = better; used for in-group ordering
  flags: string[];     // e.g. ['imposter'], ['destroyed']
  /** Asset brand colour (OPT_COLOR). Only present on type === 'asset'. */
  color?: string | null;
  /** Asset logo URL (OPT_LOGO_URL). Only present on type === 'asset'. */
  logoUrl?: string | null;
}

export interface SearchGroup {
  type: SearchType;
  label: string;
  items: SearchItem[];
}

export type SourceStatus = 'ok' | 'timeout' | 'error' | 'skipped';

export interface SearchResponse {
  query: string;
  groups: SearchGroup[];
  sources: { db: SourceStatus; explorer: SourceStatus };
}

/** Shape-derived candidate interpretations of the raw query. */
export interface Candidates {
  numeric: number | null;          // all digits, fits in a JS-safe range
  hex64: string | null;            // 64-char hex (kernel / cid / pubkey), lowercased
  pair: [string, string] | null;   // "A/B" -> ['A','B'], trimmed, both non-empty
  bansName: string | null;         // bare/.beam token, '.beam' stripped, lowercased
  ipfsCid: string | null;          // IPFS CID v0 (Qm…) or v1 (b…) — DApp content id
  text: string | null;             // free text (>= 2 chars) for fuzzy name match
}

export function classify(raw: string): Candidates {
  const s = raw.trim();
  // Normalize a grouped integer ("2,000,000" or "2.000.000") to bare digits so
  // it resolves like "2000000". Decimals like "1.5" don't match the grouping
  // pattern and are left alone.
  const ungrouped = /^\d{1,3}([.,]\d{3})+$/.test(s) ? s.replace(/[.,]/g, '') : s;
  const numeric = /^\d{1,18}$/.test(ungrouped) ? Number(ungrouped) : null;
  const hex64 = /^[0-9a-fA-F]{64}$/.test(s) ? s.toLowerCase() : null;

  // IPFS CID — v0 (Qm… base58, 46 chars) or v1 (b… base32). Used to find the
  // DApp Store entry that ships that content.
  const ipfsCid =
    /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(s) || /^b[a-z2-7]{58,}$/.test(s) ? s : null;

  let pair: [string, string] | null = null;
  if (s.includes('/')) {
    const parts = s.split('/').map((p) => p.trim());
    if (parts.length === 2 && parts[0] && parts[1]) pair = [parts[0], parts[1]];
  }

  // A CID is alphanumeric and would otherwise match the BANS-name shape — don't
  // treat it as a domain.
  const bansName =
    ipfsCid === null && /^[a-z0-9_-]{1,63}(\.beam)?$/i.test(s)
      ? s.replace(/\.beam$/i, '').toLowerCase()
      : null;

  const text = s.length >= 2 ? s : null;

  return { numeric, hex64, pair, bansName, ipfsCid, text };
}

const PER_TYPE_LIMIT = 6;

interface AssetRow {
  aid: string; name: string | null; short_name: string | null;
  unit_name: string | null; description: string | null; is_imposter: boolean;
  website: string | null; long_description: string | null;
  logo_url: string | null; color: string | null;
}

/** Resolve a token ("7" or "BEAMX") to an aid, or null. Used for pair parsing. */
async function resolveAid(token: string): Promise<bigint | null> {
  if (/^\d{1,18}$/.test(token)) return BigInt(token);
  // Tickers aren't unique — imposters mimic them. Prefer the legitimate asset
  // via assets.is_imposter (populated by seedImposters() in imposters.ts) so
  // "BEAM/BeamX" resolves to the real 0/7 pool even when an imposter shares the
  // ticker, and so real bETH (36) wins over its lower-aid imposter (17). Fall
  // back to an imposter only when it's the *only* match — a deliberate search
  // for that fake — breaking ties by lowest aid.
  const { rows } = await q<{ aid: string }>(
    `SELECT aid FROM assets
      WHERE lower(short_name) = lower($1)
      ORDER BY is_imposter ASC, aid ASC
      LIMIT 1`,
    [token],
  );
  return rows[0] ? BigInt(rows[0].aid) : null;
}

export async function searchAssets(c: Candidates): Promise<SearchItem[]> {
  const aid = c.numeric !== null ? String(c.numeric) : null;
  const text = c.text;
  if (aid === null && text === null) return [];
  // Match aid, ticker, name prefix, and asset metadata (unit name + the
  // free-text description) so a search like "stable" finds it by description.
  const { rows } = await q<AssetRow>(
    `SELECT aid, name, short_name, unit_name, description, is_imposter, website, long_description,
            logo_url, color
       FROM assets
      WHERE ($1::bigint IS NOT NULL AND aid = $1::bigint)
         OR ($2::text IS NOT NULL AND (
              lower(short_name) = lower($2)
           OR name ILIKE $2 || '%'
           OR unit_name ILIKE $2 || '%'
           OR description ILIKE '%' || $2 || '%'
           OR website ILIKE '%' || $2 || '%'
           OR long_description ILIKE '%' || $2 || '%'
         ))
      ORDER BY aid
      LIMIT ${PER_TYPE_LIMIT}`,
    [aid, text],
  );
  return rows.map((r) => {
    const t = text?.toLowerCase() ?? '';
    const exact = aid !== null && r.aid === aid;
    const ticker = text !== null && (r.short_name ?? '').toLowerCase() === t;
    const namePrefix = text !== null && (r.name ?? '').toLowerCase().startsWith(t);
    // exact aid/ticker > name prefix > metadata-only (unit/description) match.
    const base = exact ? 100 : ticker ? 90 : namePrefix ? 70 : 45;
    return {
      type: 'asset' as const,
      id: r.aid,
      title: r.short_name ? `${r.name ?? r.short_name} (${r.short_name})` : (r.name ?? `Asset ${r.aid}`),
      subtitle: `AID ${r.aid}`,
      href: `/asset/${r.aid}`,
      // Imposters stay findable but are demoted below legitimate matches.
      score: base - (r.is_imposter ? 50 : 0),
      flags: r.is_imposter ? ['imposter'] : [],
      color: r.color,
      logoUrl: r.logo_url,
    };
  });
}

interface PoolRow {
  pool_id: string; aid1: string; aid2: string; kind: number;
  s1: string | null; s2: string | null; destroyed_at_height: string | null;
}

const KIND_LABEL = ['0.05%', '0.30%', '1.00%'];

function poolItem(r: PoolRow, score: number): SearchItem {
  const a = r.s1 ?? `#${r.aid1}`;
  const b = r.s2 ?? `#${r.aid2}`;
  return {
    type: 'pool',
    id: r.pool_id,
    title: `${a}/${b}`,
    subtitle: `Pool #${r.pool_id} · ${KIND_LABEL[r.kind] ?? '?'}`,
    // The pair page resolves a bare number against aid_ctl (the LP token aid),
    // not pool_id — so link by the aid1-aid2-kind tuple, which resolvePair()
    // matches exactly (UNIQUE(aid1,aid2,kind)).
    href: `/pair/${r.aid1}-${r.aid2}-${r.kind}`,
    // Destroyed pools stay findable but are demoted below live ones.
    score: r.destroyed_at_height ? score - 50 : score,
    flags: r.destroyed_at_height ? ['destroyed'] : [],
  };
}

export async function searchPools(c: Candidates): Promise<SearchItem[]> {
  // Pair "A/B" -> resolve both sides to aids, match either ordering.
  if (c.pair) {
    const [aRaw, bRaw] = c.pair;
    const [a, b] = await Promise.all([resolveAid(aRaw), resolveAid(bRaw)]);
    if (a === null || b === null) return [];
    const { rows } = await q<PoolRow>(
      `SELECT p.pool_id, p.aid1, p.aid2, p.kind,
              a1.short_name AS s1, a2.short_name AS s2, p.destroyed_at_height
         FROM pools p
         JOIN assets a1 ON a1.aid = p.aid1
         JOIN assets a2 ON a2.aid = p.aid2
         LEFT JOIN LATERAL (
           SELECT reserve1 FROM pool_state_snapshots s
            WHERE s.pool_id = p.pool_id ORDER BY s.ts DESC LIMIT 1
         ) snap ON TRUE
        WHERE (p.aid1 = $1 AND p.aid2 = $2) OR (p.aid1 = $2 AND p.aid2 = $1)
        -- Most-liquid tier on top: live pools first, then by latest reserve.
        ORDER BY (p.destroyed_at_height IS NULL) DESC, COALESCE(snap.reserve1, 0) DESC
        LIMIT ${PER_TYPE_LIMIT}`,
      [String(a), String(b)],
    );
    return rows.map((r) => poolItem(r, 95));
  }
  // Bare number -> pool id or any pool containing that aid.
  if (c.numeric !== null) {
    const n = String(c.numeric);
    const { rows } = await q<PoolRow>(
      `SELECT p.pool_id, p.aid1, p.aid2, p.kind,
              a1.short_name AS s1, a2.short_name AS s2, p.destroyed_at_height
         FROM pools p
         JOIN assets a1 ON a1.aid = p.aid1
         JOIN assets a2 ON a2.aid = p.aid2
         LEFT JOIN LATERAL (
           SELECT reserve1 FROM pool_state_snapshots s
            WHERE s.pool_id = p.pool_id ORDER BY s.ts DESC LIMIT 1
         ) snap ON TRUE
        WHERE p.pool_id = $1::bigint OR p.aid1 = $1::bigint OR p.aid2 = $1::bigint
        ORDER BY (p.pool_id = $1::bigint) DESC, (p.destroyed_at_height IS NULL) DESC, COALESCE(snap.reserve1, 0) DESC
        LIMIT ${PER_TYPE_LIMIT}`,
      [n],
    );
    return rows.map((r) => poolItem(r, r.pool_id === n ? 100 : 70));
  }
  return [];
}

interface DappRow { id: string; name: string | null; ipfs_id: string | null }

export async function searchDapps(c: Candidates): Promise<SearchItem[]> {
  const text = c.text;
  const cid = c.ipfsCid;
  if (text === null && cid === null) return [];
  // Match on name (substring), the current IPFS content id, or any historical
  // version's CID.
  const { rows } = await q<DappRow>(
    `SELECT id, name, ipfs_id FROM dapps
      WHERE deleted_at IS NULL
        AND ( ($1::text IS NOT NULL AND name ILIKE '%' || $1 || '%')
           OR ($2::text IS NOT NULL AND ipfs_id = $2)
           OR ($2::text IS NOT NULL AND EXISTS (
                 SELECT 1 FROM dapp_versions v
                  WHERE v.dapp_id = dapps.id AND v.ipfs_hash = $2)) )
      ORDER BY (ipfs_id = $2) DESC, (lower(name) = lower($1)) DESC, name
      LIMIT ${PER_TYPE_LIMIT}`,
    [text, cid],
  );
  return rows.map((r) => {
    const byCid = cid !== null && r.ipfs_id === cid;
    const exactName = text !== null && (r.name ?? '').toLowerCase() === text.toLowerCase();
    return {
      type: 'dapp' as const,
      id: r.id,
      title: r.name ?? `DApp ${r.id}`,
      subtitle: byCid && cid ? `IPFS ${cid.slice(0, 6)}…${cid.slice(-4)}` : 'DApp',
      href: `/dapps?tab=dapps&dapp=${encodeURIComponent(r.id)}`,
      score: byCid || exactName ? 100 : 65,
      flags: [],
    };
  });
}

interface PublisherRow { pubkey: string; name: string | null }

export async function searchPublishers(c: Candidates): Promise<SearchItem[]> {
  const pubkey = c.hex64;
  const text = c.text;
  if (pubkey === null && text === null) return [];
  const { rows } = await q<PublisherRow>(
    `SELECT pubkey, name FROM dapp_publishers
      WHERE ($1::text IS NOT NULL AND pubkey = $1)
         OR ($2::text IS NOT NULL AND name ILIKE '%' || $2 || '%')
      ORDER BY (pubkey = $1) DESC, name
      LIMIT ${PER_TYPE_LIMIT}`,
    [pubkey, text],
  );
  return rows.map((r) => ({
    type: 'publisher' as const,
    id: r.pubkey,
    title: r.name ?? `Publisher ${r.pubkey.slice(0, 8)}…`,
    subtitle: `${r.pubkey.slice(0, 8)}…${r.pubkey.slice(-6)}`,
    href: `/dapps?tab=publishers&publisher=${encodeURIComponent(r.pubkey)}`,
    score: pubkey !== null && r.pubkey === pubkey ? 100 : 65,
    flags: [],
  }));
}

// Static catalog of the /explorer/charts grid — mirror of NetworkCharts.tsx
// `allCharts` (keep keys/titles in sync). A title-substring hit deep-links to
// the chart's extended (expanded) view via ?chart=<key>.
const CHART_CATALOG: ReadonlyArray<{ key: string; title: string }> = [
  { key: 'transactionsDaily', title: 'Transactions / day' },
  { key: 'transactionsTotal', title: 'Transactions (total)' },
  { key: 'feesDaily', title: 'Fees / day' },
  { key: 'feesTotal', title: 'Fees (total)' },
  { key: 'callsDaily', title: 'Contract calls / day' },
  { key: 'callsTotal', title: 'Contract calls (total)' },
  { key: 'hashrate', title: 'Hashrate (Beamhash III)' },
  { key: 'difficulty', title: 'Difficulty' },
  { key: 'blockTime', title: 'Avg block time' },
  { key: 'txosTotal', title: 'TXOs (total)' },
  { key: 'utxosTotal', title: 'UTXOs' },
  { key: 'contractsTotal', title: 'Contracts active' },
  { key: 'sizeTotal', title: 'Total blockchain size' },
  { key: 'archiveTotal', title: 'Total archive size' },
  { key: 'assets', title: 'Confidential Assets' },
  { key: 'shieldedIns', title: 'Shielded inputs / day' },
  { key: 'shieldedInsTotal', title: 'Shielded inputs (total)' },
  { key: 'shieldedOuts', title: 'Shielded outputs / day' },
  { key: 'shieldedOutsTotal', title: 'Shielded outputs (total)' },
  { key: 'dexVolume', title: 'DEX volume / day' },
  { key: 'dexVolumeCumulative', title: 'DEX volume (total)' },
  { key: 'tvl', title: 'DEX TVL' },
  { key: 'beamVol', title: 'BEAM Volatility Index (30d)' },
  { key: 'dexVol', title: 'DEX Volatility Index (30d)' },
  { key: 'blackhole', title: 'Black Hole (assets burned)' },
];

/** Match the free-text query against network-chart titles (synchronous, no I/O). */
export function searchCharts(c: Candidates): SearchItem[] {
  if (c.text === null) return [];
  const needle = c.text.toLowerCase();
  return CHART_CATALOG
    .filter((ch) => ch.title.toLowerCase().includes(needle))
    .slice(0, PER_TYPE_LIMIT)
    .map((ch) => ({
      type: 'chart' as const,
      id: ch.key,
      title: ch.title,
      subtitle: 'Network chart',
      href: `/explorer/charts?chart=${encodeURIComponent(ch.key)}`,
      score: ch.title.toLowerCase() === needle ? 100 : 70,
      flags: [],
    }));
}

// Static catalog of the contracts we hold a CID for. The explorer resolves a
// CID to a name already — searching 729fe098… returns "DEX v0" — but there was
// no way in from the name, so "what contract id does the DEX have?" had no
// answer anywhere on the site.
//
// Config is the source: these eight are validated CIDs the indexer already
// reads, so the catalog cannot drift from what is actually being indexed, and
// there is nothing to maintain when one changes. Most are `.optional()`, so an
// absent one is skipped rather than emitted as an empty id.
//
// Deliberately *not* every contract the explorer has seen. Those names come
// from a third-party parser and would need the same imposter caution assets
// get; a wrong name attached to a real CID is worse than no name.
// `cid: string | undefined` rather than `cid?:` — several of these are
// optional config and `exactOptionalPropertyTypes` rejects an explicit
// undefined against an optional property.
const CONTRACT_CATALOG: ReadonlyArray<{ title: string; keywords: string; cid: string | undefined }> = [
  { title: 'DEX',          keywords: 'dex amm pool swap trade contract cid',        cid: config.DEX_CID },
  { title: 'Oracle',       keywords: 'oracle price feed contract cid',              cid: config.ORACLE_CID },
  { title: 'DAO Vault',    keywords: 'dao vault treasury contract cid',             cid: config.DAO_VAULT_CID },
  { title: 'DAO Vote',     keywords: 'dao vote voting governance contract cid',     cid: config.DAO_VOTE_CID },
  { title: 'DApp Store',   keywords: 'dapp store registry apps contract cid',       cid: config.DAPP_STORE_CID },
  { title: 'BANS',         keywords: 'bans names domains registry contract cid',    cid: config.BANS_CID },
  { title: 'Asset Minter', keywords: 'minter asset mint contract cid',              cid: config.ASSET_MINTER_CID },
  { title: 'Black Hole',   keywords: 'blackhole black hole burn contract cid',      cid: config.BLACKHOLE_CID },
];

/**
 * Match the free-text query against known contract names + keywords
 * (synchronous, no I/O — same shape as `searchPages`).
 *
 * Emits `type: 'contract'`, so a name hit and a CID hit land in the same group
 * and the response schema is unchanged.
 */
export function searchContracts(c: Candidates): SearchItem[] {
  if (c.text === null) return [];
  const needle = c.text.toLowerCase();
  return CONTRACT_CATALOG
    .filter((k): k is { title: string; keywords: string; cid: string } => Boolean(k.cid))
    .filter((k) => k.title.toLowerCase().includes(needle) || k.keywords.toLowerCase().includes(needle))
    .slice(0, PER_TYPE_LIMIT)
    .map((k) => {
      const titleLc = k.title.toLowerCase();
      const score = titleLc === needle ? 100 : titleLc.startsWith(needle) ? 80 : 60;
      return {
        type: 'contract' as const,
        id: k.cid,
        title: k.title,
        subtitle: `${k.cid.slice(0, 8)}\u2026${k.cid.slice(-6)}`,
        href: `/explorer/beam?network=mainnet&type=contract&id=${encodeURIComponent(k.cid)}`,
        score,
        flags: [],
      };
    });
}

// Static catalog of navigable app pages.
const PAGE_CATALOG: ReadonlyArray<{ title: string; keywords: string; href: string }> = [
  { title: 'DEX',            keywords: 'dex pairs pools trade swap markets',     href: '/dex' },
  { title: 'Add liquidity',  keywords: 'liquidity provide lp pool deposit',      href: '/dex/liquidity' },
  { title: 'Assets',         keywords: 'assets tokens cas confidential',         href: '/assets' },
  { title: 'Atomic swaps',   keywords: 'atomic swaps cross-chain btc',           href: '/atomic-swaps' },
  { title: 'Asset swaps',    keywords: 'asset swaps offers otc',                 href: '/asset-swaps' },
  { title: 'DApps',          keywords: 'dapps apps store applications',          href: '/dapps' },
  { title: 'Explorer',       keywords: 'explorer blockchain',                    href: '/explorer' },
  { title: 'Network charts', keywords: 'charts stats network metrics graphs',    href: '/explorer/charts' },
  { title: 'Block explorer', keywords: 'blocks headers kernels beam explorer',   href: '/explorer/beam' },
  { title: 'BANS',           keywords: 'bans names domains beam name system',    href: '/explorer/bans' },
  { title: 'Countdown',      keywords: 'countdown halving fork',                 href: '/explorer/countdown' },
  { title: 'Health',         keywords: 'health status nodes peers',              href: '/explorer/health' },
  { title: 'Supply',         keywords: 'supply emission inflation',              href: '/explorer/supply' },
  { title: 'Bridge',         keywords: 'bridge tracker eth',                     href: '/explorer/bridge' },
  { title: 'Privacy',        keywords: 'privacy policy',                         href: '/privacy' },
];

/** Match the free-text query against app page titles + keywords (synchronous, no I/O). */
export function searchPages(c: Candidates): SearchItem[] {
  if (c.text === null) return [];
  const needle = c.text.toLowerCase();
  return PAGE_CATALOG
    .filter((p) => {
      const titleLc = p.title.toLowerCase();
      const keywordsLc = p.keywords.toLowerCase();
      return titleLc.includes(needle) || keywordsLc.includes(needle);
    })
    .slice(0, PER_TYPE_LIMIT)
    .map((p) => {
      const titleLc = p.title.toLowerCase();
      const score = titleLc === needle ? 100 : titleLc.startsWith(needle) ? 80 : 60;
      return {
        type: 'page' as const,
        id: p.href,
        title: p.title,
        subtitle: 'Page',
        href: p.href,
        score,
        flags: [],
      };
    });
}
