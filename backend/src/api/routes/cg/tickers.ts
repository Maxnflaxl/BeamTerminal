import type { FastifyInstance } from 'fastify';
import { q } from '../../../db.js';
import { loadUsdTable, type UsdTable } from '../../repos/usd.js';

/**
 * CoinGecko `/tickers` — one row per (non-imposter, non-destroyed) pool.
 *
 * Field shapes follow docs/CoinGecko.md §Endpoint 1 exactly. Numeric fields
 * are emitted as decimal STRINGS (no scientific notation, no trailing zeros
 * beyond meaningful precision).
 *
 * Pool identity:
 *   ticker_id        = "<aid1>_<aid2>_<kind>"
 *   base_currency    = "<aid1>"           (decimal string)
 *   target_currency  = "<aid2>"
 *   pool_id          = "<aid_ctl>"        (the LP token's AID; unique per pool)
 *
 * Depth formula: declared on the CG submission form as standard Uniswap V2
 * constant-product with per-tier fees 0.05%/0.30%/1.00%. We provide bid/ask
 * computed from a 1-whole-aid1 swap in each direction.
 */

interface Row {
  pool_id: string;
  aid1: string;
  aid2: string;
  kind: number;
  aid_ctl: string;
  decimals1: number;
  decimals2: number;
  reserve1: string | null;
  reserve2: string | null;
  last_price_native: string | null;
  volume_24h_aid1: string | null;
  volume_24h_aid2: string | null;
  high_24h: string | null;
  low_24h: string | null;
}

// Per-tier fee fractions (matches Amm::FeeSettings).
const TIER_FEE: Record<number, number> = {
  0: 0.0005,  // Low
  1: 0.003,   // Medium
  2: 0.01,    // High
};

/** Trim trailing zeros after the decimal point; keep at least one digit. */
function toDecimal(n: number, maxFractionDigits = 18): string {
  if (!Number.isFinite(n)) return '0';
  let s = n.toFixed(Math.min(maxFractionDigits, 20));
  if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s || '0';
}

export async function cgTickersRoutes(app: FastifyInstance): Promise<void> {
  app.get('/tickers', async (_req, reply) => {
    const usd = await loadUsdTable();

    const { rows } = await q<Row>(`
      WITH latest_snap AS (
        SELECT DISTINCT ON (pool_id) pool_id, reserve1, reserve2
          FROM pool_state_snapshots
          ORDER BY pool_id, ts DESC
      ),
      latest_trade AS (
        SELECT DISTINCT ON (pool_id) pool_id, price_native, block_ts
          FROM trades
          WHERE confirmed = TRUE AND price_native IS NOT NULL
          ORDER BY pool_id, block_ts DESC
      ),
      window_24h AS (
        SELECT pool_id,
               SUM(volume_aid1) AS v1,
               SUM(volume_aid2) AS v2,
               MAX(price_native) AS hi,
               MIN(price_native) AS lo
          FROM trades
          WHERE confirmed = TRUE AND block_ts > now() - INTERVAL '24 hours'
                AND price_native IS NOT NULL
          GROUP BY pool_id
      )
      SELECT p.pool_id::text  AS pool_id,
             p.aid1::text     AS aid1,
             p.aid2::text     AS aid2,
             p.kind           AS kind,
             p.aid_ctl::text  AS aid_ctl,
             a1.decimals      AS decimals1,
             a2.decimals      AS decimals2,
             snap.reserve1::text AS reserve1,
             snap.reserve2::text AS reserve2,
             lt.price_native::text AS last_price_native,
             w.v1::text  AS volume_24h_aid1,
             w.v2::text  AS volume_24h_aid2,
             w.hi::text  AS high_24h,
             w.lo::text  AS low_24h
        FROM pools p
        JOIN assets a1 ON a1.aid = p.aid1
        JOIN assets a2 ON a2.aid = p.aid2
        LEFT JOIN latest_snap  snap ON snap.pool_id = p.pool_id
        LEFT JOIN latest_trade lt   ON lt.pool_id   = p.pool_id
        LEFT JOIN window_24h   w    ON w.pool_id    = p.pool_id
       WHERE p.destroyed_at_height IS NULL
         AND NOT a1.is_imposter
         AND NOT a2.is_imposter
       ORDER BY p.pool_id
    `);

    const tickers = rows
      .map((r) => buildTicker(r, usd))
      .filter((t): t is Ticker => t !== null);

    void reply.header('cache-control', 'public, max-age=30');
    return tickers;
  });
}

interface Ticker {
  ticker_id: string;
  base_currency: string;
  target_currency: string;
  pool_id: string;
  last_price: string;
  base_volume: string;
  target_volume: string;
  liquidity_in_usd: string;
  bid: string;
  ask: string;
  high: string;
  low: string;
}

function buildTicker(r: Row, usd: UsdTable): Ticker | null {
  const aid1 = Number(r.aid1);
  const aid2 = Number(r.aid2);
  const r1 = r.reserve1 ? Number(r.reserve1) / 10 ** r.decimals1 : 0;
  const r2 = r.reserve2 ? Number(r.reserve2) / 10 ** r.decimals2 : 0;
  const usd1 = usd.perAid.get(aid1);
  const usd2 = usd.perAid.get(aid2);

  // Last price: prefer last trade, fall back to reserve ratio (aid2 per aid1).
  const lastPriceNative =
    r.last_price_native !== null
      ? Number(r.last_price_native)
      : r1 > 0
        ? r2 / r1
        : 0;

  // 24h volumes — whole units.
  const v1Whole = r.volume_24h_aid1
    ? Number(r.volume_24h_aid1) / 10 ** r.decimals1
    : 0;
  const v2Whole = r.volume_24h_aid2
    ? Number(r.volume_24h_aid2) / 10 ** r.decimals2
    : 0;

  // Liquidity_in_usd: both sides, summed.
  const liquidityUsd = (usd1 !== undefined ? r1 * usd1 : 0) + (usd2 !== undefined ? r2 * usd2 : 0);

  // Skip pools with zero liquidity AND zero 24h volume — keep the catalog
  // tight per CoinGecko's "no dead markets" guidance.
  if (liquidityUsd === 0 && v1Whole === 0 && v2Whole === 0) return null;

  // AMM bid/ask for a 1-whole-aid1 swap in each direction.
  const fee = TIER_FEE[r.kind] ?? 0;
  let bid = 0;
  let ask = 0;
  if (r1 > 1 && r2 > 0) {
    const dyGross = (r2 * 1) / (r1 + 1);
    bid = dyGross * (1 - fee);
    const dxGross = r2 / (r1 - 1);
    ask = dxGross / (1 - fee);
  }

  // 24h high/low: trade extremes during the window. If no trades, fall back
  // to lastPriceNative for both — CoinGecko expects something here.
  const high = r.high_24h !== null ? Number(r.high_24h) : lastPriceNative;
  const low = r.low_24h !== null ? Number(r.low_24h) : lastPriceNative;

  return {
    ticker_id: `${r.aid1}_${r.aid2}_${r.kind}`,
    base_currency: r.aid1,
    target_currency: r.aid2,
    pool_id: r.aid_ctl,
    last_price: toDecimal(lastPriceNative),
    base_volume: toDecimal(v1Whole),
    target_volume: toDecimal(v2Whole),
    liquidity_in_usd: toDecimal(liquidityUsd, 2),
    bid: toDecimal(bid),
    ask: toDecimal(ask),
    high: toDecimal(high),
    low: toDecimal(low),
  };
}
