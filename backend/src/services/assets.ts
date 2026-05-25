import { getAssets } from '../explorer.js';
import { parseAssetMetadata } from '../parsers/asset_metadata.js';
import { q } from '../db.js';
import { logger } from '../logger.js';

interface PickedRow {
  aid: number | null;
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

function pickRow(row: unknown): PickedRow | null {
  if (!Array.isArray(row) || row.length < 6) return null;
  return {
    aid: pickAid(row[0]),
    supply: pickAmount(row[3]),
    lock_height: pickHeight(row[4]),
    metadata: pickMetadata(row[5]),
  };
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

  let upserted = 0;
  for (const row of resp.value.slice(1)) {
    const picked = pickRow(row);
    if (!picked || picked.aid === null) continue;
    if (picked.aid === 0) continue; // BEAM seeded by migration

    const meta = parseAssetMetadata(picked.metadata);
    const params: ReadonlyArray<string | number | bigint | null> = [
      picked.aid,
      meta.name ?? null,
      meta.short_name ?? null,
      meta.unit_name ?? null,
      meta.description ?? null,
      8, // decimals — all observed BEAM assets are 8-decimal
      picked.supply ?? null,
      picked.lock_height ?? null,
    ];

    await q(
      `INSERT INTO assets (
         aid, name, short_name, unit_name, description, decimals, emission, lock_height, last_updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
       ON CONFLICT (aid) DO UPDATE SET
         name            = EXCLUDED.name,
         short_name      = EXCLUDED.short_name,
         unit_name       = EXCLUDED.unit_name,
         description     = EXCLUDED.description,
         emission        = EXCLUDED.emission,
         lock_height     = COALESCE(EXCLUDED.lock_height, assets.lock_height),
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
export async function ensureAssetExists(aid: number, firstSeenHeight: number): Promise<void> {
  await q(
    `INSERT INTO assets (aid, decimals, first_seen_height)
     VALUES ($1, 8, $2)
     ON CONFLICT (aid) DO NOTHING`,
    [aid, firstSeenHeight],
  );
}
