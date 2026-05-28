import { q, QueryArg } from '../db.js';
import { logger } from '../logger.js';
import { getSwapOffers, getSwapTotals, SwapOffer, SwapTotalsResponse } from '../explorer.js';

// ---------------------------------------------------------------------------
// Cross-chain atomic-swap mirror.
//
// Two endpoints, both polled every indexer tick (cheap):
//   /swap_offers  → upsert into atomic_swap_offers, mark vanished offers gone
//   /swap_totals  → append one row to atomic_swap_totals_snapshots
//
// Both endpoints 404 when the explorer was built without
// `BEAM_ATOMIC_SWAP_SUPPORT`. We treat any HTTP error from the explorer as
// "feature not available right now" and no-op without crashing the tick.
// ---------------------------------------------------------------------------

// Map from explorer's integer enum → human-readable label. Order pinned by
// `wallet/transactions/swaps/common.cpp` and confirmed against the field
// ordering of /swap_totals. When a build mints new values we'll see unknown
// ints in the logs.
const SWAP_CURRENCY_NAMES: Record<number, string> = {
  0: 'BEAM',
  1: 'BTC',
  2: 'LTC',
  3: 'QTUM',
  4: 'DOGE',
  5: 'DASH',
  6: 'ETH',
  7: 'DAI',
  8: 'USDT',
  9: 'WBTC',
};

function parseCurrency(raw: SwapOffer['swap_currency']): number {
  if (typeof raw === 'number') return raw;
  const n = Number(raw);
  return Number.isFinite(n) ? n : -1;
}

function parseTimeCreated(s: string): Date {
  // Explorer formats time_created as "YYYY.MM.DD HH:MM:SS" in UTC. JS Date
  // cannot parse the dotted form, so rewrite to ISO first.
  const iso = s.replace(/^(\d{4})\.(\d{2})\.(\d{2}) /, '$1-$2-$3T') + 'Z';
  const d = new Date(iso);
  if (Number.isFinite(d.getTime())) return d;
  // Fallback: treat as epoch seconds if the string was actually numeric.
  const n = Number(s);
  if (Number.isFinite(n) && n > 0) return new Date(n * 1000);
  return new Date(0);
}

function parseAmount(s: string): string {
  // Already a decimal-string; stripping any whitespace just in case.
  return s.trim();
}

export async function syncAtomicSwapOffers(): Promise<{ open: number; closed: number } | null> {
  let offers: SwapOffer[];
  try {
    offers = await getSwapOffers();
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : err },
      'atomic /swap_offers unavailable; skipping (likely BEAM_ATOMIC_SWAP_SUPPORT off)',
    );
    return null;
  }

  if (offers.length === 0) {
    const { rowCount } = await q(
      'UPDATE atomic_swap_offers SET gone_at = now() WHERE gone_at IS NULL',
    );
    return { open: 0, closed: rowCount ?? 0 };
  }

  const cols = [
    'tx_id',
    'is_beam_side',
    'status',
    'status_string',
    'beam_amount',
    'swap_amount',
    'swap_currency',
    'swap_currency_name',
    'time_created',
    'min_height',
    'height_expired',
  ];
  const placeholders: string[] = [];
  const params: QueryArg[] = [];
  for (const o of offers) {
    const cur = parseCurrency(o.swap_currency);
    const base = params.length;
    placeholders.push(
      `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},` +
      `$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11})`,
    );
    params.push(
      o.txId,
      Boolean(o.is_beam_side),
      o.status,
      o.status_string ?? null,
      parseAmount(o.beam_amount),
      parseAmount(o.swap_amount),
      cur,
      SWAP_CURRENCY_NAMES[cur] ?? null,
      parseTimeCreated(o.time_created),
      o.min_height ?? null,
      o.height_expired ?? null,
    );
  }

  await q(
    `INSERT INTO atomic_swap_offers (${cols.join(',')})
     VALUES ${placeholders.join(',')}
     ON CONFLICT (tx_id, is_beam_side) DO UPDATE SET
       status             = EXCLUDED.status,
       status_string      = EXCLUDED.status_string,
       beam_amount        = EXCLUDED.beam_amount,
       swap_amount        = EXCLUDED.swap_amount,
       swap_currency      = EXCLUDED.swap_currency,
       swap_currency_name = EXCLUDED.swap_currency_name,
       time_created       = EXCLUDED.time_created,
       min_height         = EXCLUDED.min_height,
       height_expired     = EXCLUDED.height_expired,
       last_seen_at       = now(),
       gone_at            = NULL`,
    params,
  );

  // Mark the disappeared. The natural key is (tx_id, is_beam_side); express
  // the "not in this batch" check via a NOT EXISTS join against a VALUES
  // table instead of unnest+zip — clearer to read.
  const visible = offers.map((o) => [o.txId, Boolean(o.is_beam_side)] as const);
  const visiblePlaceholders = visible
    .map((_, i) => `($${i * 2 + 1}::text, $${i * 2 + 2}::boolean)`)
    .join(',');
  const visibleParams: QueryArg[] = visible.flatMap((v) => [v[0], v[1]]);

  const { rowCount } = await q(
    `UPDATE atomic_swap_offers o
       SET gone_at = now()
     WHERE gone_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM (VALUES ${visiblePlaceholders}) AS v(tx_id, is_beam_side)
         WHERE v.tx_id = o.tx_id AND v.is_beam_side = o.is_beam_side
       )`,
    visibleParams,
  );

  logger.debug({ open: offers.length, closed: rowCount }, 'atomic_swap_offers synced');
  return { open: offers.length, closed: rowCount ?? 0 };
}

export async function snapshotAtomicSwapTotals(headHeight: number): Promise<void> {
  let totals: SwapTotalsResponse;
  try {
    totals = await getSwapTotals();
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : err },
      'atomic /swap_totals unavailable; skipping',
    );
    return;
  }

  await q(
    `INSERT INTO atomic_swap_totals_snapshots
       (ts, height, total_swaps_count,
        beams_offered, bitcoin_offered, litecoin_offered, qtum_offered,
        dogecoin_offered, dash_offered, ethereum_offered, dai_offered,
        usdt_offered, wbtc_offered)
     VALUES (now(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (ts) DO NOTHING`,
    [
      headHeight,
      totals.total_swaps_count,
      totals.beams_offered,
      totals.bitcoin_offered,
      totals.litecoin_offered,
      totals.qtum_offered,
      totals.dogecoin_offered,
      totals.dash_offered,
      totals.ethereum_offered,
      totals.dai_offered,
      totals.usdt_offered,
      totals.wbtc_offered,
    ],
  );
}
