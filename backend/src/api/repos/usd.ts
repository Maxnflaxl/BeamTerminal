import { q } from '../../db.js';

/**
 * USD valuation table built off the BEAM oracle median + on-chain pool reserves.
 *
 * Strategy: for each non-BEAM asset, find the **deepest BEAM-quoted pool**
 * (pool where aid1=0=BEAM is paired with that asset) and derive
 *
 *     usd_per_whole_unit = beam_usd × (BEAM-per-aid rate from that pool)
 *
 * "Deepest" = highest BEAM reserve (reserve1, since BEAM is canonical aid1 < other).
 * The all-time BEAM/USD price is sourced from the most recent oracle snapshot.
 *
 * Assets not reachable via a BEAM-quoted pool have no USD rate (Map omits them);
 * callers treat that as "no USD valuation possible".
 *
 * Cached for one request lifetime — call once at the top of each handler.
 */
export interface UsdTable {
  beam_usd: number | null;
  /** USD value of 1 *whole unit* (post-decimals) of the given AID. */
  perAid: Map<number, number>;
}

interface DeepestPoolRow {
  aid_other: string;       // the non-BEAM aid
  beam_reserve: string;    // BEAM groths in the pool (aid1=0)
  other_reserve: string;   // groths of aid_other (aid2)
  other_decimals: number;
}

interface OracleRow {
  beam_usd: string;
}

export async function loadUsdTable(): Promise<UsdTable> {
  const { rows: oracle } = await q<OracleRow>(
    'SELECT beam_usd::text FROM oracle_snapshots ORDER BY ts DESC LIMIT 1',
  );
  const beamUsd = oracle[0] ? Number(oracle[0].beam_usd) : null;

  const perAid = new Map<number, number>();
  // BEAM itself: 1 whole BEAM = beamUsd USD.
  if (beamUsd !== null) perAid.set(0, beamUsd);

  if (beamUsd === null) return { beam_usd: beamUsd, perAid };

  // For each non-BEAM aid that appears in a BEAM-quoted pool, take the deepest
  // such pool by BEAM reserve and derive USD-per-whole-unit.
  const { rows } = await q<DeepestPoolRow>(`
    WITH latest AS (
      SELECT DISTINCT ON (pool_id) pool_id, reserve1, reserve2
        FROM pool_state_snapshots
        ORDER BY pool_id, ts DESC
    ),
    beam_pools AS (
      SELECT p.pool_id, p.aid2 AS aid_other, l.reserve1 AS beam_reserve,
             l.reserve2 AS other_reserve, a2.decimals AS other_decimals
        FROM pools p
        JOIN latest l   ON l.pool_id = p.pool_id
        JOIN assets a2  ON a2.aid    = p.aid2
       WHERE p.aid1 = 0
         AND p.destroyed_at_height IS NULL
         AND l.reserve1 > 0
         AND l.reserve2 > 0
    ),
    ranked AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY aid_other ORDER BY beam_reserve DESC) AS rn
        FROM beam_pools
    )
    SELECT aid_other::text, beam_reserve::text, other_reserve::text, other_decimals
      FROM ranked
     WHERE rn = 1
  `);

  for (const r of rows) {
    const aid = Number(r.aid_other);
    const beamReserve = Number(r.beam_reserve) / 1e8;  // BEAM has 8 decimals
    const otherReserve = Number(r.other_reserve) / 10 ** r.other_decimals;
    if (otherReserve <= 0) continue;
    // BEAM per 1 whole aid = beamReserve / otherReserve
    const beamPerWholeAid = beamReserve / otherReserve;
    perAid.set(aid, beamPerWholeAid * beamUsd);
  }

  return { beam_usd: beamUsd, perAid };
}
