import type { FastifyInstance } from 'fastify';
import { q } from '../../db.js';
import { BadRequest, NotFound } from '../error.js';
import { getAssetHistory } from '../../explorer.js';
import type { Row, TypedCell } from '../../explorer.js';

// Tiny in-process LRU for /asset/{aid}/history — explorer can be slow on
// long histories and the data only changes when the asset mints/burns.
const HISTORY_CACHE_MS = 5 * 60 * 1000;
const historyCache = new Map<number, { ts: number; payload: HistoryItem[] }>();

interface HistoryItem {
  height: number;
  ts: number | null;
  event: string;
  amount: string | null;
  total_amount: string | null;
  extra: string;
}

interface AssetRow {
  aid: string;
  name: string | null;
  short_name: string | null;
  unit_name: string | null;
  description: string | null;
  decimals: number;
  is_imposter: boolean;
  emission: string | null;
  first_seen_height: string | null;
  minter_cid: string | null;
  max_supply: string | null;
  color: string | null;
  logo_url: string | null;
  owner_cid: string | null;
  owner_kind: string | null;
  owner_addr: string | null;
}

interface AssetPoolRow {
  pool_id: string;
  kind: number;
  aid1: string;
  aid2: string;
  reserve1: string | null;
  reserve2: string | null;
  decimals1: number;
  decimals2: number;
}

async function readBeamUsd(): Promise<number | null> {
  const { rows } = await q<{ beam_usd: string }>(
    'SELECT beam_usd::text AS beam_usd FROM oracle_snapshots ORDER BY ts DESC LIMIT 1',
  );
  return rows[0] ? Number(rows[0].beam_usd) : null;
}

interface AssetListRow {
  aid: string;
  name: string | null;
  short_name: string | null;
  unit_name: string | null;
  description: string | null;
  decimals: number;
  is_imposter: boolean;
  imposter_reason: string | null;
  emission: string | null;
  first_seen_height: string | null;
  minter_cid: string | null;
  max_supply: string | null;
  color: string | null;
  logo_url: string | null;
  pool_count: string;
}

export async function assetRoutes(app: FastifyInstance): Promise<void> {
  // List of every asset known to the backend, with per-asset pool counts.
  // No pagination — there are ~200 assets on mainnet today; small enough to send wholesale.
  app.get('/assets', async (_req, reply) => {
    const { rows } = await q<AssetListRow>(`
      SELECT a.aid::text, a.name, a.short_name, a.unit_name, a.description,
             a.decimals, a.is_imposter, a.imposter_reason,
             a.emission::text, a.first_seen_height::text,
             a.minter_cid, a.max_supply::text, a.color, a.logo_url,
             COALESCE(pc.cnt, 0)::text AS pool_count
        FROM assets a
   LEFT JOIN (
              SELECT aid, COUNT(*)::int AS cnt FROM (
                SELECT aid1 AS aid FROM pools WHERE destroyed_at_height IS NULL
                UNION ALL
                SELECT aid2 AS aid FROM pools WHERE destroyed_at_height IS NULL
              ) p GROUP BY aid
            ) pc ON pc.aid = a.aid
        ORDER BY a.aid ASC
    `);
    void reply.header('cache-control', 'public, max-age=30');
    return {
      assets: rows.map((r) => ({
        aid: Number(r.aid),
        name: r.name,
        short_name: r.short_name,
        unit_name: r.unit_name,
        description: r.description,
        decimals: r.decimals,
        is_imposter: r.is_imposter,
        imposter_reason: r.imposter_reason,
        emission: r.emission,
        first_seen_height: r.first_seen_height ? Number(r.first_seen_height) : null,
        minter_cid: r.minter_cid,
        max_supply: r.max_supply,
        color: r.color,
        logo_url: r.logo_url,
        pool_count: Number(r.pool_count),
      })),
    };
  });

  app.get<{ Params: { aid: string } }>('/asset/:aid', async (req, reply) => {
    const aid = Number(req.params.aid);
    if (!Number.isFinite(aid) || aid < 0) {
      throw BadRequest('BAD_REQUEST', 'aid must be a non-negative integer');
    }

    const { rows } = await q<AssetRow>(
      `SELECT aid::text, name, short_name, unit_name, description, decimals,
              is_imposter, emission::text, first_seen_height::text,
              minter_cid, max_supply::text, color, logo_url, owner_cid, owner_kind, owner_addr
         FROM assets
        WHERE aid = $1`,
      [aid],
    );
    if (rows.length === 0) throw NotFound('ASSET_NOT_FOUND', `no asset ${aid}`);
    const asset = rows[0]!;

    const { rows: poolRows } = await q<AssetPoolRow>(
      `SELECT p.pool_id::text, p.kind, p.aid1::text, p.aid2::text,
              snap.reserve1::text, snap.reserve2::text,
              a1.decimals AS decimals1, a2.decimals AS decimals2
         FROM pools p
         JOIN assets a1 ON a1.aid = p.aid1
         JOIN assets a2 ON a2.aid = p.aid2
         LEFT JOIN LATERAL (
           SELECT reserve1, reserve2
             FROM pool_state_snapshots s
            WHERE s.pool_id = p.pool_id
            ORDER BY s.ts DESC
            LIMIT 1
         ) snap ON TRUE
        WHERE (p.aid1 = $1 OR p.aid2 = $1)
          AND p.destroyed_at_height IS NULL`,
      [aid],
    );

    const beamUsd = await readBeamUsd();
    const pools = poolRows.map((p) => {
      const a1 = Number(p.aid1);
      const a2 = Number(p.aid2);
      const r1 = p.reserve1 ? Number(p.reserve1) / 10 ** p.decimals1 : null;
      const r2 = p.reserve2 ? Number(p.reserve2) / 10 ** p.decimals2 : null;
      let tvlUsd: number | null = null;
      if (beamUsd !== null) {
        if (a1 === 0 && r1 !== null && r2 !== null) {
          // BEAM/X — both sides USD via reserve ratio
          // 1 BEAM = r2/r1 of aid2, so aid2-USD = beamUsd / (r2/r1)
          const priceUsd = r2 > 0 ? beamUsd * (r1 / r2) : null;
          if (priceUsd !== null) tvlUsd = +(r1 * beamUsd + r2 * priceUsd).toFixed(2);
        } else if (a2 === 0 && r1 !== null && r2 !== null) {
          // X/BEAM (rare)
          const priceUsd = r1 > 0 ? beamUsd * (r2 / r1) : null;
          if (priceUsd !== null) tvlUsd = +(r2 * beamUsd + r1 * priceUsd).toFixed(2);
        }
      }
      return {
        pair_id: Number(p.pool_id),
        aid1: a1,
        aid2: a2,
        kind: p.kind,
        tvl_usd: tvlUsd,
      };
    });

    void reply.header('cache-control', 'public, max-age=30');
    return {
      aid: Number(asset.aid),
      name: asset.name,
      short_name: asset.short_name,
      unit_name: asset.unit_name,
      description: asset.description,
      decimals: asset.decimals,
      is_imposter: asset.is_imposter,
      emission: asset.emission,
      first_seen_height: asset.first_seen_height ? Number(asset.first_seen_height) : null,
      minter_cid: asset.minter_cid,
      max_supply: asset.max_supply,
      color: asset.color,
      logo_url: asset.logo_url,
      owner_cid: asset.owner_cid,
      owner_kind: asset.owner_kind,
      owner_addr: asset.owner_addr,
      pools,
    };
  });

  // -------------------------------------------------------------------------
  // /asset/{aid}/history — pass-through over explorer /asset?id=N, parsed
  // and lightly cached. Returns mint/burn/create/destroy events.
  // -------------------------------------------------------------------------
  app.get<{ Params: { aid: string }; Querystring: { limit?: string } }>(
    '/asset/:aid/history',
    async (req, reply) => {
      const aid = Number(req.params.aid);
      if (!Number.isFinite(aid) || aid <= 0) {
        throw BadRequest(
          'BAD_REQUEST',
          aid === 0
            ? 'aid 0 (BEAM) has no history endpoint — see /api/asset/0 instead'
            : 'aid must be a positive integer',
        );
      }
      const limitRaw = req.query.limit ? Number(req.query.limit) : 100;
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 100;

      // Cache lookup (cache key includes limit so different limits don't
      // collide; in practice almost everyone uses the default).
      const cacheKey = aid * 10_000 + limit;
      const hit = historyCache.get(cacheKey);
      const now = Date.now();
      if (hit && now - hit.ts < HISTORY_CACHE_MS) {
        void reply.header('cache-control', 'public, max-age=300');
        return { aid, history: hit.payload, cached: true };
      }

      const resp = await getAssetHistory({ id: aid, hMin: 0, nMaxOps: limit });
      const tbl = resp['Asset history'];
      const rawHistory: HistoryItem[] = [];
      if (tbl && tbl.type === 'table') {
        for (const row of tbl.value.slice(1)) {
          if (!Array.isArray(row)) continue;
          const r = row as Row;
          rawHistory.push({
            height: pickN(r[0]) ?? 0,
            ts: null,
            event: pickS(r[1]) ?? '',
            amount: pickAmt(r[2]),
            total_amount: pickAmt(r[3]),
            extra: pickS(r[4]) ?? '',
          });
        }
      }

      // Attach block_ts to every event so the frontend can plot supply over
      // time. We only have timestamps for blocks the indexer has touched
      // (DEX deploy onward); older heights stay `null` and the client can
      // anchor them to first_seen_height of the asset if needed.
      const heights = Array.from(new Set(rawHistory.map((h) => h.height).filter((h) => h > 0)));
      const tsByHeight = new Map<number, number>();
      if (heights.length > 0) {
        const { rows: tsRows } = await q<{ height: string; ts: string }>(
          `SELECT height::text, EXTRACT(EPOCH FROM ts)::text AS ts
             FROM block_timestamps
            WHERE height = ANY($1::bigint[])`,
          [heights],
        );
        for (const r of tsRows) tsByHeight.set(Number(r.height), Math.floor(Number(r.ts)));
      }
      const history = rawHistory.map((h) => ({ ...h, ts: tsByHeight.get(h.height) ?? null }));

      historyCache.set(cacheKey, { ts: now, payload: history });
      void reply.header('cache-control', 'public, max-age=300');
      return { aid, history, cached: false };
    },
  );
}

function isTyped(x: unknown): x is TypedCell {
  return typeof x === 'object' && x !== null && 'type' in x;
}
function pickN(c: unknown): number | null {
  if (typeof c === 'number') return c;
  if (isTyped(c) && typeof c.value === 'number') return c.value;
  return null;
}
function pickS(c: unknown): string | null {
  if (typeof c === 'string') return c;
  if (isTyped(c) && typeof c.value === 'string') return c.value;
  return null;
}
function pickAmt(c: unknown): string | null {
  if (isTyped(c) && c.type === 'amount') return String(c.value);
  return null;
}
