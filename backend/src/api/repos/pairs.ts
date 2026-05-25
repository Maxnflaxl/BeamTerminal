import { q } from '../../db.js';

export interface PairRowRaw {
  pool_id: string;
  aid1: string;
  aid2: string;
  kind: number;
  aid_ctl: string;
  symbol1: string | null;
  symbol2: string | null;
  decimals1: number;
  decimals2: number;
  is_imposter1: boolean;
  is_imposter2: boolean;
  reserve1: string | null;
  reserve2: string | null;
  ctl_supply: string | null;
  snapshot_height: string | null;
  last_price_native: string | null;
  last_trade_ts: Date | null;
  volume_24h_aid1: string | null;
  trades_24h: string;
  buys_24h: string;
  sells_24h: string;
  price_24h_ago: string | null;
  created_at_height: string;
}

export type SortKey =
  | 'tvl_usd'
  | 'volume_24h_usd'
  | 'price_change_24h'
  | 'trades_24h'
  | 'aid2';

export interface ListOpts {
  sort_by: SortKey;
  order: 'asc' | 'desc';
  limit: number;
  offset: number;
  search?: string;
  kind?: 0 | 1 | 2;
  include_imposters: boolean;
}

/**
 * Pulls all denormalized pair data in a single query. Built around 5 LATERALs
 * per pool (snapshot, latest trade, 24h aggregates, 24h-ago trade, last-trade-ts).
 *
 * Sorting / pagination happens in the outer SELECT — we sort on a derived
 * column so we materialize the entire CTE first. Acceptable at ~100 pools.
 */
export async function listPairs(opts: ListOpts): Promise<PairRowRaw[]> {
  const sortColumn = ({
    tvl_usd: 'tvl_aid1_groth',
    volume_24h_usd: 'volume_24h_aid1',
    price_change_24h: 'price_change_24h',
    trades_24h: 'trades_24h',
    aid2: 'aid2',
  } as const)[opts.sort_by];
  const direction = opts.order === 'asc' ? 'ASC NULLS LAST' : 'DESC NULLS LAST';

  const params: Array<unknown> = [opts.limit, opts.offset];
  const where: string[] = ['p.destroyed_at_height IS NULL'];
  if (!opts.include_imposters) {
    where.push('NOT a1.is_imposter');
    where.push('NOT a2.is_imposter');
  }
  if (opts.kind !== undefined) {
    params.push(opts.kind);
    where.push(`p.kind = $${params.length}`);
  }
  if (opts.search) {
    // Split on "/" so users can narrow by pair, e.g. "BEAM/BeamX". Single
    // tokens still match either side (symbol substring OR exact AID).
    const parts = opts.search.split('/').map((s) => s.trim()).filter(Boolean);
    if (parts.length === 1) {
      const raw = parts[0]!;
      params.push(`%${raw}%`, raw);
      const li = params.length - 1;
      const ei = params.length;
      where.push(
        `(a1.short_name ILIKE $${li} OR a2.short_name ILIKE $${li}
          OR p.aid1::text = $${ei} OR p.aid2::text = $${ei})`,
      );
    } else {
      const leftRaw = parts[0]!;
      const rightRaw = parts[1]!;
      params.push(`%${leftRaw}%`, leftRaw, `%${rightRaw}%`, rightRaw);
      const ll = params.length - 3;
      const le = params.length - 2;
      const rl = params.length - 1;
      const re = params.length;
      where.push(`(
        ((a1.short_name ILIKE $${ll} OR p.aid1::text = $${le})
         AND (a2.short_name ILIKE $${rl} OR p.aid2::text = $${re}))
        OR
        ((a2.short_name ILIKE $${ll} OR p.aid2::text = $${le})
         AND (a1.short_name ILIKE $${rl} OR p.aid1::text = $${re}))
      )`);
    }
  }

  const sql = `
    SELECT
      p.pool_id::text   AS pool_id,
      p.aid1::text      AS aid1,
      p.aid2::text      AS aid2,
      p.kind            AS kind,
      p.aid_ctl::text   AS aid_ctl,
      a1.short_name     AS symbol1,
      a2.short_name     AS symbol2,
      a1.decimals       AS decimals1,
      a2.decimals       AS decimals2,
      a1.is_imposter    AS is_imposter1,
      a2.is_imposter    AS is_imposter2,
      snap.reserve1::text AS reserve1,
      snap.reserve2::text AS reserve2,
      snap.ctl_supply::text AS ctl_supply,
      snap.height::text AS snapshot_height,
      latest_trade.price_native::text AS last_price_native,
      latest_trade.block_ts AS last_trade_ts,
      agg.volume_24h_aid1::text AS volume_24h_aid1,
      agg.trades_24h::text  AS trades_24h,
      agg.buys_24h::text    AS buys_24h,
      agg.sells_24h::text   AS sells_24h,
      price_24h.price_24h_ago::text AS price_24h_ago,
      p.created_at_height::text AS created_at_height,
      -- Derived for sorting only; not selected back:
      COALESCE(snap.reserve1, 0) AS tvl_aid1_groth,
      CASE
        WHEN latest_trade.price_native IS NOT NULL
         AND price_24h.price_24h_ago    IS NOT NULL
         AND price_24h.price_24h_ago    > 0
        THEN ((latest_trade.price_native - price_24h.price_24h_ago)
              / price_24h.price_24h_ago) * 100
      END AS price_change_24h
    FROM pools p
    JOIN assets a1 ON a1.aid = p.aid1
    JOIN assets a2 ON a2.aid = p.aid2
    LEFT JOIN LATERAL (
      SELECT reserve1, reserve2, ctl_supply, height
        FROM pool_state_snapshots s
       WHERE s.pool_id = p.pool_id
       ORDER BY s.ts DESC
       LIMIT 1
    ) snap ON TRUE
    LEFT JOIN LATERAL (
      SELECT price_native, block_ts
        FROM trades t
       WHERE t.pool_id = p.pool_id AND t.price_native IS NOT NULL
       ORDER BY t.block_ts DESC
       LIMIT 1
    ) latest_trade ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        SUM(volume_aid1)                       AS volume_24h_aid1,
        count(*)                               AS trades_24h,
        count(*) FILTER (WHERE aid_in = p.aid1) AS buys_24h,
        count(*) FILTER (WHERE aid_in = p.aid2) AS sells_24h
      FROM trades t
      WHERE t.pool_id = p.pool_id
        AND t.block_ts > now() - INTERVAL '24 hours'
    ) agg ON TRUE
    LEFT JOIN LATERAL (
      SELECT price_native AS price_24h_ago
        FROM trades t
       WHERE t.pool_id = p.pool_id
         AND t.block_ts <= now() - INTERVAL '24 hours'
         AND t.price_native IS NOT NULL
       ORDER BY t.block_ts DESC
       LIMIT 1
    ) price_24h ON TRUE
    WHERE ${where.join(' AND ')}
    ORDER BY ${sortColumn} ${direction}
    LIMIT $1 OFFSET $2
  `;

  const { rows } = await q<PairRowRaw>(sql, params as ReadonlyArray<string | number | bigint | boolean | Date | Buffer | null>);
  return rows;
}

export async function getPairByPoolId(poolId: number): Promise<PairRowRaw | null> {
  const rows = await listPairs({
    sort_by: 'aid2',
    order: 'asc',
    limit: 1,
    offset: 0,
    include_imposters: true,
  });
  return rows.find((r) => Number(r.pool_id) === poolId) ?? null;
}

/** Resolve "aid1_aid2_kind" (or legacy "aid1-aid2-kind") or an LP token aid
 *  into a numeric pool_id. The internal pool_id is NOT a valid public URL
 *  form — only the LP aid (user-facing identifier shared by tools like
 *  BeamScreener) and the tuple are accepted. */
export async function resolvePairId(idOrTuple: string): Promise<number | null> {
  if (/^\d+$/.test(idOrTuple)) {
    const n = Number(idOrTuple);
    const { rows } = await q<{ pool_id: string }>(
      `SELECT pool_id::text FROM pools
        WHERE aid_ctl = $1 AND destroyed_at_height IS NULL
        LIMIT 1`,
      [n],
    );
    return rows[0] ? Number(rows[0].pool_id) : null;
  }
  const m = idOrTuple.match(/^(\d+)[-_](\d+)[-_](\d)$/);
  if (!m) return null;
  const [, aid1, aid2, kind] = m;
  const { rows } = await q<{ pool_id: string }>(
    `SELECT pool_id::text FROM pools
      WHERE aid1 = $1 AND aid2 = $2 AND kind = $3 AND destroyed_at_height IS NULL`,
    [Number(aid1), Number(aid2), Number(kind)],
  );
  return rows[0] ? Number(rows[0].pool_id) : null;
}
