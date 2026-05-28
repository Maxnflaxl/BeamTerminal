import type { FastifyInstance } from 'fastify';
import { q } from '../../db.js';

// ---------------------------------------------------------------------------
// /api/atomic-swaps        — current cross-chain offers
// /api/atomic-swaps/totals — latest aggregate totals
// /api/atomic-swaps/totals/history?since=ISO — historical totals series
// ---------------------------------------------------------------------------

interface AtomicSwapOfferRow {
  tx_id: string;
  is_beam_side: boolean;
  status: number;
  status_string: string | null;
  beam_amount: string;
  swap_amount: string;
  swap_currency: number;
  swap_currency_name: string | null;
  time_created: Date;
  min_height: string | null;
  height_expired: string | null;
  first_seen_at: Date;
  last_seen_at: Date;
  gone_at: Date | null;
}

interface AtomicSwapTotalsRow {
  ts: Date;
  height: string | null;
  total_swaps_count: number | null;
  beams_offered: string | null;
  bitcoin_offered: string | null;
  litecoin_offered: string | null;
  qtum_offered: string | null;
  dogecoin_offered: string | null;
  dash_offered: string | null;
  ethereum_offered: string | null;
  dai_offered: string | null;
  usdt_offered: string | null;
  wbtc_offered: string | null;
}

function shapeTotals(r: AtomicSwapTotalsRow): Record<string, unknown> {
  return {
    ts: r.ts.toISOString(),
    height: r.height ? Number(r.height) : null,
    total_swaps_count: r.total_swaps_count,
    offered: {
      BEAM: r.beams_offered,
      BTC: r.bitcoin_offered,
      LTC: r.litecoin_offered,
      QTUM: r.qtum_offered,
      DOGE: r.dogecoin_offered,
      DASH: r.dash_offered,
      ETH: r.ethereum_offered,
      DAI: r.dai_offered,
      USDT: r.usdt_offered,
      WBTC: r.wbtc_offered,
    },
  };
}

export async function atomicSwapsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { include?: string; currency?: string; side?: string } }>(
    '/atomic-swaps',
    async (req, reply) => {
      const includeClosed = req.query.include === 'closed' || req.query.include === 'all';
      const currency = req.query.currency?.toUpperCase();
      const side = req.query.side; // 'beam' | 'counter' | undefined

      const where: string[] = [];
      const params: (string | number | boolean)[] = [];

      if (!includeClosed) where.push('gone_at IS NULL');
      if (currency) {
        params.push(currency);
        where.push(`swap_currency_name = $${params.length}`);
      }
      if (side === 'beam' || side === 'counter') {
        params.push(side === 'beam');
        where.push(`is_beam_side = $${params.length}`);
      }

      const { rows } = await q<AtomicSwapOfferRow>(
        `SELECT tx_id, is_beam_side, status, status_string,
                beam_amount::text, swap_amount::text,
                swap_currency, swap_currency_name,
                time_created, min_height::text, height_expired::text,
                first_seen_at, last_seen_at, gone_at
           FROM atomic_swap_offers
          ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
          ORDER BY ${includeClosed ? 'last_seen_at DESC' : 'time_created DESC'}
          LIMIT 500`,
        params,
      );

      void reply.header('cache-control', 'public, max-age=15');
      return {
        offers: rows.map((r) => ({
          tx_id: r.tx_id,
          is_beam_side: r.is_beam_side,
          status: r.status,
          status_string: r.status_string,
          beam_amount: r.beam_amount,
          swap_amount: r.swap_amount,
          swap_currency: r.swap_currency,
          swap_currency_name: r.swap_currency_name,
          time_created: r.time_created.toISOString(),
          min_height: r.min_height ? Number(r.min_height) : null,
          height_expired: r.height_expired ? Number(r.height_expired) : null,
          first_seen_at: r.first_seen_at.toISOString(),
          last_seen_at: r.last_seen_at.toISOString(),
          gone_at: r.gone_at ? r.gone_at.toISOString() : null,
        })),
      };
    },
  );

  app.get('/atomic-swaps/totals', async (_req, reply) => {
    const { rows } = await q<AtomicSwapTotalsRow>(
      `SELECT ts, height::text, total_swaps_count,
              beams_offered, bitcoin_offered, litecoin_offered, qtum_offered,
              dogecoin_offered, dash_offered, ethereum_offered, dai_offered,
              usdt_offered, wbtc_offered
         FROM atomic_swap_totals_snapshots
        ORDER BY ts DESC
        LIMIT 1`,
    );
    void reply.header('cache-control', 'public, max-age=30');
    if (rows.length === 0) return { latest: null };
    return { latest: shapeTotals(rows[0]!) };
  });

  app.get<{ Querystring: { since?: string; bucket?: string } }>(
    '/atomic-swaps/totals/history',
    async (req, reply) => {
      // Default to the last 30 days. `bucket` controls down-sampling: '1h' (default)
      // returns at most ~720 points for the default window — comfortable for a chart.
      const since = req.query.since ? new Date(req.query.since) : new Date(Date.now() - 30 * 24 * 3600 * 1000);
      const bucket = req.query.bucket === '1d' ? '1 day' : req.query.bucket === '15m' ? '15 minutes' : '1 hour';

      const { rows } = await q<AtomicSwapTotalsRow>(
        `SELECT time_bucket($1::interval, ts) AS ts,
                MAX(height)::text AS height,
                MAX(total_swaps_count) AS total_swaps_count,
                MAX(beams_offered::numeric)::text     AS beams_offered,
                MAX(bitcoin_offered::numeric)::text   AS bitcoin_offered,
                MAX(litecoin_offered::numeric)::text  AS litecoin_offered,
                MAX(qtum_offered::numeric)::text      AS qtum_offered,
                MAX(dogecoin_offered::numeric)::text  AS dogecoin_offered,
                MAX(dash_offered::numeric)::text      AS dash_offered,
                MAX(ethereum_offered::numeric)::text  AS ethereum_offered,
                MAX(dai_offered::numeric)::text       AS dai_offered,
                MAX(usdt_offered::numeric)::text      AS usdt_offered,
                MAX(wbtc_offered::numeric)::text      AS wbtc_offered
           FROM atomic_swap_totals_snapshots
          WHERE ts >= $2
          GROUP BY 1
          ORDER BY 1 ASC`,
        [bucket, since],
      );

      void reply.header('cache-control', 'public, max-age=60');
      return {
        bucket,
        since: since.toISOString(),
        points: rows.map(shapeTotals),
      };
    },
  );
}
