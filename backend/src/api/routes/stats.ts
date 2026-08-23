import type { FastifyInstance } from 'fastify';
import { q } from '../../db.js';
import { loadUsdTable } from '../repos/usd.js';
import { readDexStats } from '../../services/dexStats.js';
import { BRIDGES } from '../../services/bridge.js';

interface ScalarRow {
  oracle_ts: Date | null;
  last_indexed_height: string | null;
  cursor_ts: Date | null;
  total_pairs: string;
  // BEAM's circulating supply in groths. Synced from the explorer's
  // /status?exp_am=1 totals by services/beamSupply.ts, stored on the aid-0
  // asset row rather than a table of its own.
  circulating_groths: string | null;
}

interface PoolReserveRow {
  aid1: string;
  aid2: string;
  decimals1: number;
  decimals2: number;
  reserve1: string | null;
  reserve2: string | null;
}

interface EscrowRow {
  bridge: string;
  locked: string | null;
  decimals: number;
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
    const [usd, scalarsRes, reservesRes, volumesRes, cachedStats, escrowRes] = await Promise.all([
      loadUsdTable(),
      q<ScalarRow>(`
        SELECT
          (SELECT ts FROM oracle_snapshots ORDER BY ts DESC LIMIT 1) AS oracle_ts,
          (SELECT last_indexed_height::text FROM cursor WHERE id = 1) AS last_indexed_height,
          (SELECT updated_at FROM cursor WHERE id = 1) AS cursor_ts,
          (SELECT count(*)::text FROM pools WHERE destroyed_at_height IS NULL) AS total_pairs,
          (SELECT emission::text FROM assets WHERE aid = 0) AS circulating_groths
      `),
      // Latest reserves per active pool, joined with both side's decimals
      // so we can value each leg via the per-AID USD table.
      // LATERAL + LIMIT 1 uses the (pool_id, ts DESC) index; ~9ms vs ~4.5s
      // for DISTINCT ON which scanned the entire hypertable.
      q<PoolReserveRow>(`
        SELECT p.aid1::text, p.aid2::text,
               a1.decimals AS decimals1, a2.decimals AS decimals2,
               l.reserve1::text, l.reserve2::text
          FROM pools p
          JOIN assets a1 ON a1.aid = p.aid1
          JOIN assets a2 ON a2.aid = p.aid2
          CROSS JOIN LATERAL (
            SELECT reserve1, reserve2
              FROM pool_state_snapshots ss
             WHERE ss.pool_id = p.pool_id
             ORDER BY ss.ts DESC
             LIMIT 1
          ) l
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
      // One row per bridge — a handful. The rest of /bridge/health is far
      // heavier (a GROUP BY over bridge_messages), which is why only the
      // escrow slice is pulled in here rather than calling getBridgeHealth().
      q<EscrowRow>('SELECT bridge, locked::text, decimals FROM bridge_escrow'),
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

    // Escrowed collateral across the bridges, valued the same way
    // /bridge/health does: off the Beam-side asset, since the wrapped token
    // tracks its collateral 1:1 and that is the side with a BEAM-quoted pool.
    // Bridges we cannot price are absent from the total rather than counted
    // as zero, so the figure is null until at least one is priceable.
    const aidOf = new Map(BRIDGES.map((b) => [b.key, b.aid]));
    let bridgeTvlUsd: number | null = null;
    for (const row of escrowRes.rows) {
      if (row.locked === null) continue;
      const aid = aidOf.get(row.bridge);
      if (aid === undefined) continue;
      const price = usd.perAid.get(aid);
      if (price === undefined) continue;
      bridgeTvlUsd = (bridgeTvlUsd ?? 0) + (Number(row.locked) / 10 ** row.decimals) * price;
    }

    // Circulating supply in whole BEAM, and the market cap it implies. Both
    // are null unless the supply sync has run and the oracle has a price —
    // a market cap computed from half the inputs is worse than no answer.
    const circulatingSupply =
      scalars?.circulating_groths != null ? Number(scalars.circulating_groths) / 1e8 : null;
    const marketCapUsd =
      circulatingSupply !== null && usd.beam_usd !== null
        ? +(circulatingSupply * usd.beam_usd).toFixed(2)
        : null;

    void reply.header('cache-control', 'public, max-age=15');
    return {
      beam_usd: usd.beam_usd,
      total_tvl_usd: tvlHasAny ? +totalTvlUsd.toFixed(2) : null,
      volume_24h_usd: volHasAny ? +volume24hUsd.toFixed(2) : null,
      total_volume_usd: totalVolumeUsd !== null ? +totalVolumeUsd.toFixed(2) : null,
      circulating_supply: circulatingSupply !== null ? +circulatingSupply.toFixed(8) : null,
      market_cap_usd: marketCapUsd,
      // All-time high BEAM/USD. Served from the dex_stats cache because the
      // query behind it scans a hypertable — see services/dexStats.ts, which
      // also explains why the figure is not simply max(oracle_snapshots).
      ath_usd: cachedStats.ath_usd,
      ath_ts: cachedStats.ath_ts ? Math.floor(cachedStats.ath_ts.getTime() / 1000) : null,
      atl_usd: cachedStats.atl_usd,
      atl_ts: cachedStats.atl_ts ? Math.floor(cachedStats.atl_ts.getTime() / 1000) : null,
      bridge_tvl_usd: bridgeTvlUsd !== null ? +bridgeTvlUsd.toFixed(2) : null,
      total_pairs: Number(scalars?.total_pairs ?? 0),
      total_trades: cachedStats.total_trades ?? 0,
      last_indexed_height: Number(scalars?.last_indexed_height ?? 0),
      block_ts: scalars?.oracle_ts ? Math.floor(scalars.oracle_ts.getTime() / 1000) : null,
    };
  });
}
