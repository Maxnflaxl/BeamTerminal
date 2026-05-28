import type { FastifyInstance } from 'fastify';
import { q } from '../../db.js';

// ---------------------------------------------------------------------------
// /api/asset-swaps[?include=closed&send=AID&receive=AID]
//
// Wallet-gossiped DEX offers, mirrored from the wallet-api by
// services/assetSwapOffers.ts. Default response is open offers only
// (gone_at IS NULL AND expire_time > now()). Use ?include=closed to also
// return offers we've marked gone, sorted by last_seen_at DESC.
// ---------------------------------------------------------------------------

interface AssetSwapOfferRow {
  id: string;
  is_my: boolean;
  send_asset_id: number;
  send_amount: string;
  send_currency_name: string | null;
  receive_asset_id: number;
  receive_amount: string;
  receive_currency_name: string | null;
  create_time: Date;
  expire_time: Date;
  first_seen_at: Date;
  last_seen_at: Date;
  gone_at: Date | null;
}

function parseAidParam(s: string | undefined): number | null {
  if (s === undefined) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
}

export async function assetSwapsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { include?: string; send?: string; receive?: string } }>(
    '/asset-swaps',
    async (req, reply) => {
      const includeClosed = req.query.include === 'closed' || req.query.include === 'all';
      const send = parseAidParam(req.query.send);
      const receive = parseAidParam(req.query.receive);

      const where: string[] = [];
      const params: (string | number)[] = [];

      if (!includeClosed) {
        where.push('gone_at IS NULL', 'expire_time > now()');
      }
      if (send !== null) {
        params.push(send);
        where.push(`send_asset_id = $${params.length}`);
      }
      if (receive !== null) {
        params.push(receive);
        where.push(`receive_asset_id = $${params.length}`);
      }

      const { rows } = await q<AssetSwapOfferRow>(
        `SELECT id, is_my,
                send_asset_id, send_amount::text, send_currency_name,
                receive_asset_id, receive_amount::text, receive_currency_name,
                create_time, expire_time, first_seen_at, last_seen_at, gone_at
           FROM asset_swap_offers
          ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
          ORDER BY ${includeClosed ? 'last_seen_at DESC' : 'expire_time ASC'}
          LIMIT 500`,
        params,
      );

      // Open-offer list is gossip data; let it cache briefly so a hammering UI
      // poll doesn't query the DB every second.
      void reply.header('cache-control', 'public, max-age=15');
      return {
        offers: rows.map((r) => ({
          id: r.id,
          is_my: r.is_my,
          send: {
            asset_id: r.send_asset_id,
            amount: r.send_amount,
            currency_name: r.send_currency_name,
          },
          receive: {
            asset_id: r.receive_asset_id,
            amount: r.receive_amount,
            currency_name: r.receive_currency_name,
          },
          create_time: r.create_time.toISOString(),
          expire_time: r.expire_time.toISOString(),
          first_seen_at: r.first_seen_at.toISOString(),
          last_seen_at: r.last_seen_at.toISOString(),
          gone_at: r.gone_at ? r.gone_at.toISOString() : null,
        })),
      };
    },
  );
}
