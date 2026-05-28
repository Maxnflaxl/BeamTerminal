import { config } from '../config.js';
import { q, QueryArg } from '../db.js';
import { logger } from '../logger.js';
import { listAssetSwapOffers, WalletApiUnavailableError, AssetSwapOffer } from '../walletApi.js';

// ---------------------------------------------------------------------------
// Mirror the wallet-api's `assets_swap_offers_list` into asset_swap_offers.
//
// Lifecycle model is the same as `atomicSwaps`: upsert visible offers, then
// mark anything we didn't see this tick as `gone_at = now()`. We don't know
// the terminal state (filled vs cancelled vs expired) — only that the gossip
// network has stopped advertising it.
//
// The wallet-api enforces `API_READ_ACCESS` on this method, so no writes ever
// happen. Wallet daemon needs to be reachable; if WALLET_API_URL is unset we
// no-op so deployments without the daemon don't fail every tick.
// ---------------------------------------------------------------------------

function unixSecondsToDate(s: number): Date {
  // wallet-api returns unix seconds. Date() expects ms.
  return new Date(s * 1000);
}

export async function syncAssetSwapOffers(): Promise<{ open: number; closed: number } | null> {
  if (!config.WALLET_API_URL) return null;

  let offers: AssetSwapOffer[];
  try {
    offers = await listAssetSwapOffers();
  } catch (err) {
    if (err instanceof WalletApiUnavailableError) return null;
    throw err;
  }

  if (offers.length === 0) {
    // No open offers — close everything still marked open.
    const { rowCount } = await q(
      'UPDATE asset_swap_offers SET gone_at = now() WHERE gone_at IS NULL',
    );
    return { open: 0, closed: rowCount ?? 0 };
  }

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
      Boolean(o.isMy),
      o.sendAssetId,
      String(o.sendAmount),
      o.sendCurrencyName ?? null,
      o.receiveAssetId,
      String(o.receiveAmount),
      o.receiveCurrencyName ?? null,
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
