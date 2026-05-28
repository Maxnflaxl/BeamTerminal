import { getAssets, getContracts } from '../explorer.js';
import { parseAssetMetadata } from '../parsers/asset_metadata.js';
import { q } from '../db.js';
import { logger } from '../logger.js';

interface PickedRow {
  aid: number | null;
  /** Issuing contract CID when the Owner column is `{type:"cid"}`; null for
   *  wallet-issued assets (Owner is a `{type:"blob"}` owner-key). */
  owner_cid: string | null;
  /** Wallet owner-key when the Owner column is `{type:"blob"}`; null for
   *  contract-issued assets. */
  owner_addr: string | null;
  supply: bigint | null;
  lock_height: number | null;
  metadata: string;
}

function pickAid(cell: unknown): number | null {
  if (typeof cell === 'object' && cell !== null) {
    const v = (cell as { type?: unknown; value?: unknown });
    if (v.type === 'aid' && typeof v.value === 'number') return v.value;
  }
  if (typeof cell === 'number') return cell;
  return null;
}

function pickAmount(cell: unknown): bigint | null {
  if (typeof cell === 'object' && cell !== null) {
    const v = (cell as { type?: unknown; value?: unknown });
    if (v.type === 'amount') {
      const raw = v.value;
      if (typeof raw === 'string') {
        try {
          return BigInt(raw.replace(/^[+-]/, raw[0] === '-' ? '-' : ''));
        } catch {
          return null;
        }
      }
      if (typeof raw === 'number') return BigInt(Math.trunc(raw));
    }
  }
  return null;
}

function pickHeight(cell: unknown): number | null {
  if (typeof cell === 'number' && Number.isFinite(cell)) return cell;
  if (typeof cell === 'string') {
    const n = Number(cell);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof cell === 'object' && cell !== null) {
    const v = (cell as { type?: unknown; value?: unknown });
    if (v.type === 'height' && typeof v.value === 'number') return v.value;
    if (typeof v.value === 'number') return v.value;
    if (typeof v.value === 'string') {
      const n = Number(v.value);
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
}

function pickMetadata(cell: unknown): string {
  if (typeof cell === 'string') return cell;
  if (typeof cell === 'object' && cell !== null) {
    const v = (cell as { value?: unknown }).value;
    if (typeof v === 'string') return v;
  }
  return '';
}

/**
 * Reads the /assets "Owner" column. Contract-issued assets carry
 * `{type:"cid", value:<contract-id>}`; wallet-issued ones carry
 * `{type:"blob", value:<owner-key>}` (or an empty string). We return the CID
 * for the contract case and null otherwise — that's the wallet/contract split
 * the UI's issuer label hinges on.
 */
function pickOwnerCid(cell: unknown): string | null {
  if (typeof cell === 'object' && cell !== null) {
    const v = cell as { type?: unknown; value?: unknown };
    if (v.type === 'cid' && typeof v.value === 'string') return v.value;
  }
  return null;
}

/** Wallet owner-key from a `{type:"blob"}` Owner cell; null otherwise. */
function pickOwnerAddr(cell: unknown): string | null {
  if (typeof cell === 'object' && cell !== null) {
    const v = cell as { type?: unknown; value?: unknown };
    if (v.type === 'blob' && typeof v.value === 'string' && v.value !== '') return v.value;
  }
  return null;
}

function pickRow(row: unknown): PickedRow | null {
  if (!Array.isArray(row) || row.length < 6) return null;
  return {
    aid: pickAid(row[0]),
    owner_cid: pickOwnerCid(row[1]),
    owner_addr: pickOwnerAddr(row[1]),
    supply: pickAmount(row[3]),
    lock_height: pickHeight(row[4]),
    metadata: pickMetadata(row[5]),
  };
}

/**
 * Builds a CID → parser-name map from the explorer's /contracts table
 * (header `[Cid, Kind, Deploy Height, Locked Funds, Owned Assets]`). The Kind
 * column is the human-readable name the explorer's parser.wasm assigns
 * ("DEX v0", "Nephrite v1", "Minter", …). Returns an empty map on any failure
 * so a missing /contracts response just leaves owner_kind null (the UI then
 * shows a generic "Contract" label).
 */
async function fetchContractKinds(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const resp = await getContracts();
    if (resp.type !== 'table' || !Array.isArray(resp.value)) return map;
    for (const row of resp.value.slice(1)) {
      if (!Array.isArray(row)) continue;
      const cid = pickOwnerCid(row[0]);
      const kind = typeof row[1] === 'string' ? row[1].trim() : '';
      if (cid && kind) map.set(cid, kind);
    }
  } catch (err) {
    logger.warn({ err }, 'fetchContractKinds failed; owner_kind will be null this sync');
  }
  return map;
}

/**
 * Pulls /assets, upserts every row into our `assets` table. Idempotent.
 * Skips aid 0 (BEAM, seeded by migration; metadata is empty).
 *
 * Returns the number of rows upserted.
 */
export async function syncAssetsCatalog(): Promise<number> {
  const resp = await getAssets();
  if (resp.type !== 'table') {
    throw new Error('unexpected /assets response (no table)');
  }

  // Resolve owner CIDs to parser names once per sync (the catalog has many
  // assets but only a handful of distinct issuing contracts).
  const contractKinds = await fetchContractKinds();

  let upserted = 0;
  for (const row of resp.value.slice(1)) {
    const picked = pickRow(row);
    if (!picked || picked.aid === null) continue;
    if (picked.aid === 0) continue; // BEAM seeded by migration

    const meta = parseAssetMetadata(picked.metadata);
    const ownerKind = picked.owner_cid ? contractKinds.get(picked.owner_cid) ?? null : null;
    const params: ReadonlyArray<string | number | bigint | null> = [
      picked.aid,
      meta.name ?? null,
      meta.short_name ?? null,
      meta.unit_name ?? null,
      meta.description ?? null,
      8, // decimals — all observed BEAM assets are 8-decimal
      picked.supply ?? null,
      picked.lock_height ?? null,
      meta.color ?? null,
      meta.logo_url ?? null,
      picked.owner_cid,
      ownerKind,
      picked.owner_addr,
    ];

    await q(
      `INSERT INTO assets (
         aid, name, short_name, unit_name, description, decimals, emission, lock_height, color, logo_url, owner_cid, owner_kind, owner_addr, last_updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now())
       ON CONFLICT (aid) DO UPDATE SET
         name            = EXCLUDED.name,
         short_name      = EXCLUDED.short_name,
         unit_name       = EXCLUDED.unit_name,
         description     = EXCLUDED.description,
         emission        = EXCLUDED.emission,
         lock_height     = COALESCE(EXCLUDED.lock_height, assets.lock_height),
         color           = EXCLUDED.color,
         logo_url        = EXCLUDED.logo_url,
         owner_cid       = EXCLUDED.owner_cid,
         owner_kind      = COALESCE(EXCLUDED.owner_kind, assets.owner_kind),
         owner_addr      = EXCLUDED.owner_addr,
         last_updated_at = now()`,
      params,
    );
    upserted++;
  }

  logger.info({ upserted, total: resp.value.length - 1 }, 'assets catalog synced');
  return upserted;
}

/**
 * Ensures a single asset row exists. Used when the indexer encounters an AID
 * we haven't seen yet (e.g. a freshly-created LP token between catalog syncs).
 * Stores only the AID + decimals; metadata will be filled on the next
 * syncAssetsCatalog() pass.
 */
// AIDs we've already ensured this process. The insert below is
// `ON CONFLICT DO NOTHING`, so once an AID is present every later call is a
// guaranteed no-op round-trip — the cache skips it. Safe to keep for the life
// of the process: reorgs never delete `assets` rows (they only touch
// trades / lp_events / pool_state_snapshots / block_timestamps and un-mark
// pools), so a row we've inserted stays inserted. `first_seen_height` is only
// written on the first insert anyway (DO NOTHING never updates it), so
// short-circuiting later calls changes no stored value.
const ensuredAids = new Set<number>();

export async function ensureAssetExists(aid: number, firstSeenHeight: number): Promise<void> {
  if (ensuredAids.has(aid)) return;
  await q(
    `INSERT INTO assets (aid, decimals, first_seen_height)
     VALUES ($1, 8, $2)
     ON CONFLICT (aid) DO NOTHING`,
    [aid, firstSeenHeight],
  );
  ensuredAids.add(aid);
}
