import type { FastifyInstance } from 'fastify';
import { q } from '../../db.js';
import { loadUsdTable } from '../repos/usd.js';
import { readDexStats } from '../../services/dexStats.js';

interface ScalarRow {
  oracle_ts: Date | null;
  last_indexed_height: string | null;
  cursor_ts: Date | null;
  total_pairs: string;
  total_trades: string;
}

interface PoolReserveRow {
  aid1: string;
  aid2: string;
  decimals1: number;
  decimals2: number;
  reserve1: string | null;
  reserve2: string | null;
}

interface VolumeRow {
  pool_id: string;
  aid1: string;
  aid2: string;
  decimals1: number;
  decimals2: number;
  volume_24h_aid1: string | null;
  volume_24h_aid2: string | null;
}

export async function statsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/stats', async (_req, reply) => {
    // Load USD-per-AID rates in parallel with the scalar/aggregate queries.
    // `total_volume_usd` comes from the precomputed `dex_stats` table —
    // see services/dexStats.ts for why it's not inlined here.
    const [usd, scalarsRes, reservesRes, volumesRes, cachedStats] = await Promise.all([
      loadUsdTable(),
      q<ScalarRow>(`
        SELECT
          (SELECT ts FROM oracle_snapshots ORDER BY ts DESC LIMIT 1) AS oracle_ts,
          (SELECT last_indexed_height::text FROM cursor WHERE id = 1) AS last_indexed_height,
          (SELECT updated_at FROM cursor WHERE id = 1) AS cursor_ts,
          (SELECT count(*)::text FROM pools WHERE destroyed_at_height IS NULL) AS total_pairs,
          (SELECT count(*)::text FROM trades WHERE confirmed = TRUE) AS total_trades
      `),
      // Latest reserves per active pool, joined with both side's decimals
      // so we can value each leg via the per-AID USD table.
      q<PoolReserveRow>(`
        WITH latest AS (
          SELECT DISTINCT ON (pool_id) pool_id, reserve1, reserve2
            FROM pool_state_snapshots
            ORDER BY pool_id, ts DESC
        )
        SELECT p.aid1::text, p.aid2::text,
               a1.decimals AS decimals1, a2.decimals AS decimals2,
               l.reserve1::text, l.reserve2::text
          FROM pools p
          JOIN latest l  ON l.pool_id = p.pool_id
          JOIN assets a1 ON a1.aid = p.aid1
          JOIN assets a2 ON a2.aid = p.aid2
         WHERE p.destroyed_at_height IS NULL
      `),
      // 24h swap volume per pool, both legs. Volume in USD is summed across
      // both sides and halved (each swap moves equal value in and out, so
      // counting both legs would double-count).
      q<VolumeRow>(`
        SELECT t.pool_id::text, p.aid1::text, p.aid2::text,
               a1.decimals AS decimals1, a2.decimals AS decimals2,
               SUM(t.volume_aid1)::text AS volume_24h_aid1,
               SUM(t.volume_aid2)::text AS volume_24h_aid2
          FROM trades t
          JOIN pools  p  ON p.pool_id = t.pool_id
          JOIN assets a1 ON a1.aid = p.aid1
          JOIN assets a2 ON a2.aid = p.aid2
         WHERE t.block_ts > now() - INTERVAL '24 hours'
           AND t.confirmed = TRUE
         GROUP BY t.pool_id, p.aid1, p.aid2, a1.decimals, a2.decimals
      `),
      readDexStats(),
    ]);

    const scalars = scalarsRes.rows[0];

    // TVL = Σ over active pools of (reserve1_usd + reserve2_usd). For pools
    // where only one side has a USD rate, we double the known side: AMMs hold
    // equal value on both sides at equilibrium, so this is the best estimate.
    // Pools where neither side is priceable are skipped.
    let totalTvlUsd = 0;
    let tvlHasAny = false;
    for (const r of reservesRes.rows) {
      const aid1 = Number(r.aid1);
      const aid2 = Number(r.aid2);
      const usd1 = usd.perAid.get(aid1) ?? null;
      const usd2 = usd.perAid.get(aid2) ?? null;
      const reserve1 = r.reserve1 ? Number(r.reserve1) / 10 ** r.decimals1 : 0;
      const reserve2 = r.reserve2 ? Number(r.reserve2) / 10 ** r.decimals2 : 0;
      const side1 = usd1 !== null ? reserve1 * usd1 : null;
      const side2 = usd2 !== null ? reserve2 * usd2 : null;
      if (side1 !== null && side2 !== null) {
        totalTvlUsd += side1 + side2;
        tvlHasAny = true;
      } else if (side1 !== null) {
        totalTvlUsd += side1 * 2;
        tvlHasAny = true;
      } else if (side2 !== null) {
        totalTvlUsd += side2 * 2;
        tvlHasAny = true;
      }
    }

    // 24h volume: sum USD value of one side per pool (the side we have a USD
    // rate for); a swap moves equal value across, so picking either is fine.
    // Prefer aid1 side since it's our canonical denomination.
    const sumPoolVolumesUsd = (rows: VolumeRow[]): { value: number; any: boolean } => {
      let total = 0;
      let any = false;
      for (const v of rows) {
        const aid1 = Number(v.aid1);
        const aid2 = Number(v.aid2);
        const usd1 = usd.perAid.get(aid1) ?? null;
        const usd2 = usd.perAid.get(aid2) ?? null;
        const vol1 = v.volume_24h_aid1 ? Number(v.volume_24h_aid1) / 10 ** v.decimals1 : 0;
        const vol2 = v.volume_24h_aid2 ? Number(v.volume_24h_aid2) / 10 ** v.decimals2 : 0;
        let usdVal: number | null = null;
        if (usd1 !== null) usdVal = vol1 * usd1;
        else if (usd2 !== null) usdVal = vol2 * usd2;
        if (usdVal !== null) {
          total += usdVal;
          any = true;
        }
      }
      return { value: total, any };
    };

    const { value: volume24hUsd, any: volHasAny } = sumPoolVolumesUsd(volumesRes.rows);
    // Point-in-time total volume: precomputed by the indexer; null until the
    // first refresh completes after a fresh deploy.
    const totalVolumeUsd = cachedStats.total_volume_usd;

    void reply.header('cache-control', 'public, max-age=15');
    return {
      beam_usd: usd.beam_usd,
      total_tvl_usd: tvlHasAny ? +totalTvlUsd.toFixed(2) : null,
      volume_24h_usd: volHasAny ? +volume24hUsd.toFixed(2) : null,
      total_volume_usd: totalVolumeUsd !== null ? +totalVolumeUsd.toFixed(2) : null,
      total_pairs: Number(scalars?.total_pairs ?? 0),
      total_trades: Number(scalars?.total_trades ?? 0),
      last_indexed_height: Number(scalars?.last_indexed_height ?? 0),
      block_ts: scalars?.oracle_ts ? Math.floor(scalars.oracle_ts.getTime() / 1000) : null,
    };
  });
}
