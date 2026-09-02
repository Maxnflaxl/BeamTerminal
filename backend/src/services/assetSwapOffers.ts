import { q, QueryArg } from '../db.js';
import { logger } from '../logger.js';
import { ExplorerHttpError, getAssetSwaps, AssetSwapOfferRaw } from '../explorer.js';

// ---------------------------------------------------------------------------
// Mirror the explorer's `/asset_swaps` feed into asset_swap_offers.
//
// These are wallet-gossiped DEX orders (asset-to-asset, distinct from the
// cross-chain atomic swaps). Until BeamMW/beam #2054 they were only reachable
// through the wallet-api's `assets_swap_offers_list`; the explorer now serves
// them directly, so this subsystem no longer needs the wallet daemon.
//
// Lifecycle model is the same as `atomicSwaps`: upsert visible offers, then
// mark anything we didn't see this tick as `gone_at = now()`. We don't know
// the terminal state (filled vs cancelled vs expired) — only that the gossip
// network has stopped advertising it.
//
// The explorer feed is gated behind `BEAM_ASSET_SWAP_SUPPORT`; a build without
// it returns 404, which we treat as "feature unavailable" and no-op so those
// deployments don't fail every tick.
// ---------------------------------------------------------------------------

function unixSecondsToDate(s: number): Date {
  // The explorer returns unix seconds. Date() expects ms.
  return new Date(s * 1000);
}

// Convert a formatted decimal amount string into atomic (groth-equivalent)
// units, using the asset's declared decimal places. The explorer renders these
// with thousands separators and the asset's own decimals — e.g. BEAM (8 dp)
// "10,624.16998671", bUSDT (asset 37) "200". Amounts routinely exceed
// Number.MAX_SAFE_INTEGER, so do the scaling with BigInt string math rather
// than floats.
function decimalToAtomic(formatted: string, decimals: number): string {
  const clean = formatted.replace(/,/g, '').trim();
  const neg = clean.startsWith('-');
  const unsigned = neg ? clean.slice(1) : clean;
  const [intPart = '0', fracRaw = ''] = unsigned.split('.');
  // Pad (or, defensively, truncate) the fractional part to exactly `decimals`
  // digits. The explorer already formats to the asset's decimals, so this is
  // an exact reconstruction in practice; truncation is a safety net.
  const frac = (fracRaw + '0'.repeat(decimals)).slice(0, decimals);
  const atomic = BigInt(intPart || '0') * 10n ** BigInt(decimals) + BigInt(frac || '0');
  return (neg ? -atomic : atomic).toString();
}

// 404 from the explorer means it was built without BEAM_ASSET_SWAP_SUPPORT.
function isFeatureUnavailable(err: unknown): boolean {
  return err instanceof ExplorerHttpError && err.statusCode === 404;
}

export async function syncAssetSwapOffers(): Promise<{ open: number; closed: number } | null> {
  let offers: AssetSwapOfferRaw[];
  try {
    offers = await getAssetSwaps();
  } catch (err) {
    if (isFeatureUnavailable(err)) return null;
    throw err;
  }

  if (offers.length === 0) {
    // No open offers — close everything still marked open.
    const { rowCount } = await q(
      'UPDATE asset_swap_offers SET gone_at = now() WHERE gone_at IS NULL',
    );
    return { open: 0, closed: rowCount ?? 0 };
  }

  // Amounts arrive as decimals formatted with each asset's decimal places.
  // Pull the catalog's decimals so we can reconstruct atomic units; default to
  // 8 (every observed BEAM asset is 8-decimal — see services/assets.ts) for an
  // asset we haven't catalogued yet. The 10-minute asset resync normally has
  // it by the time it shows up in an offer.
  const decRows = await q<{ aid: number; decimals: number }>('SELECT aid, decimals FROM assets');
  const decimalsByAid = new Map(decRows.rows.map((r) => [r.aid, r.decimals]));
  const decFor = (aid: number): number => decimalsByAid.get(aid) ?? 8;

  // Upsert each visible offer in a single statement using a VALUES list.
  // `last_seen_at` is bumped on every hit; `gone_at` is reset to NULL in case
  // an offer briefly disappeared then came back (rare but possible during
  // gossip propagation hiccups).
  const cols = [
    'id',
    'is_my',
    'send_asset_id',
    'send_amount',
    'send_currency_name',
    'receive_asset_id',
    'receive_amount',
    'receive_currency_name',
    'create_time',
    'expire_time',
  ];
  const placeholders: string[] = [];
  const params: QueryArg[] = [];
  for (const o of offers) {
    const base = params.length;
    placeholders.push(
      `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},` +
      `$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10})`,
    );
    params.push(
      o.id,
      // The explorer has no wallet — every offer is someone else's.
      false,
      o.send_asset_id,
      decimalToAtomic(o.send_amount, decFor(o.send_asset_id)),
      o.send_currency ?? null,
      o.receive_asset_id,
      decimalToAtomic(o.receive_amount, decFor(o.receive_asset_id)),
      o.receive_currency ?? null,
      unixSecondsToDate(o.create_time),
      unixSecondsToDate(o.expire_time),
    );
  }

  await q(
    `INSERT INTO asset_swap_offers (${cols.join(',')})
     VALUES ${placeholders.join(',')}
     ON CONFLICT (id) DO UPDATE SET
       is_my                 = EXCLUDED.is_my,
       send_asset_id         = EXCLUDED.send_asset_id,
       send_amount           = EXCLUDED.send_amount,
       send_currency_name    = EXCLUDED.send_currency_name,
       receive_asset_id      = EXCLUDED.receive_asset_id,
       receive_amount        = EXCLUDED.receive_amount,
       receive_currency_name = EXCLUDED.receive_currency_name,
       create_time           = EXCLUDED.create_time,
       expire_time           = EXCLUDED.expire_time,
       last_seen_at          = now(),
       gone_at               = NULL`,
    params,
  );

  // Anyone not in the visible set this tick is closed.
  const ids = offers.map((o) => o.id);
  const { rowCount } = await q(
    `UPDATE asset_swap_offers
       SET gone_at = now()
     WHERE gone_at IS NULL
       AND id <> ALL ($1::text[])`,
    [ids],
  );

  logger.debug({ open: offers.length, closed: rowCount }, 'asset_swap_offers synced');
  return { open: offers.length, closed: rowCount ?? 0 };
}
