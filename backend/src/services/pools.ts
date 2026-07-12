import { config } from '../config.js';
import { getContract } from '../explorer.js';
import { parsePoolsTable, type PoolStateRow } from '../parsers/amm.js';
import { ensureAssetExists } from './assets.js';
import { q } from '../db.js';
import { logger } from '../logger.js';

interface PoolRow {
  pool_id: string;
}

/**
 * Resolves the internal pool_ids for a batch of (aid1, aid2, kind) tuples in
 * one statement, creating missing rows. The DO UPDATE only fires when aid_ctl
 * actually changed (it essentially never does) — an unconditional upsert would
 * rewrite every pools row every 30s tick, bloating a table every API pair
 * query joins. Unchanged rows come back from the pre-statement `pools` scan
 * instead (their pool_id is stable, so snapshot visibility is irrelevant).
 */
async function upsertPools(
  pools: PoolStateRow[],
  createdAtHeight: number,
): Promise<Map<string, bigint>> {
  const { rows } = await q<PoolRow & { aid1: string; aid2: string; kind: number }>(
    `WITH input AS (
       SELECT * FROM unnest($1::bigint[], $2::bigint[], $3::smallint[], $4::bigint[]) AS t(aid1, aid2, kind, aid_ctl)
     ),
     ins AS (
       INSERT INTO pools (aid1, aid2, kind, aid_ctl, created_at_height)
       SELECT aid1, aid2, kind, aid_ctl, $5 FROM input
       ON CONFLICT (aid1, aid2, kind) DO UPDATE
         SET aid_ctl = EXCLUDED.aid_ctl
         WHERE pools.aid_ctl IS DISTINCT FROM EXCLUDED.aid_ctl
       RETURNING pool_id, aid1, aid2, kind
     )
     SELECT i.aid1::text, i.aid2::text, i.kind,
            COALESCE(ins.pool_id, p.pool_id)::text AS pool_id
       FROM input i
       LEFT JOIN ins ON ins.aid1 = i.aid1 AND ins.aid2 = i.aid2 AND ins.kind = i.kind
       LEFT JOIN pools p ON p.aid1 = i.aid1 AND p.aid2 = i.aid2 AND p.kind = i.kind`,
    [
      pools.map((p) => p.aid1),
      pools.map((p) => p.aid2),
      pools.map((p) => p.kind),
      pools.map((p) => p.aid_ctl),
      createdAtHeight,
    ],
  );
  const out = new Map<string, bigint>();
  for (const r of rows) {
    out.set(`${r.aid1}-${r.aid2}-${r.kind}`, BigInt(r.pool_id));
  }
  return out;
}

export interface PoolKey {
  aid1: number;
  aid2: number;
  kind: 0 | 1 | 2;
}

export async function resolvePoolId(key: PoolKey): Promise<bigint | null> {
  const { rows } = await q<PoolRow>(
    'SELECT pool_id FROM pools WHERE aid1 = $1 AND aid2 = $2 AND kind = $3',
    [key.aid1, key.aid2, key.kind],
  );
  return rows[0] ? BigInt(rows[0].pool_id) : null;
}

/**
 * Reads the DEX's current state and writes one row per pool into
 * `pool_state_snapshots`. Returns the parsed pool list so callers (the
 * indexer) can also use the data for derived stats without re-fetching.
 */
export async function snapshotPoolStates(headHeight: number, headTs: Date): Promise<PoolStateRow[]> {
  const resp = await getContract({ id: config.DEX_CID, state: true, nMaxTxs: 0 });
  const pools = parsePoolsTable(resp);
  if (pools.length === 0) {
    logger.info({ height: headHeight, pools: 0 }, 'pool state snapshot written');
    return pools;
  }

  // Assets first (FK targets). ensureAssetExists memoizes in-process, so
  // after the first tick these all return without a query.
  for (const p of pools) {
    await ensureAssetExists(p.aid1, headHeight);
    await ensureAssetExists(p.aid2, headHeight);
    await ensureAssetExists(p.aid_ctl, headHeight);
  }

  const poolIds = await upsertPools(pools, headHeight);
  const resolved = pools.map((p) => {
    const poolId = poolIds.get(`${p.aid1}-${p.aid2}-${p.kind}`);
    if (poolId === undefined) {
      // Can't happen (upsertPools returns a row per input tuple) — guard so a
      // parser regression fails loudly instead of snapshotting a wrong pool.
      throw new Error(`upsertPools returned no pool_id for ${p.aid1}-${p.aid2}-${p.kind}`);
    }
    return { p, poolId };
  });

  // One multi-row insert for all snapshots (they share this tick's ts, so the
  // (pool_id, ts) conflict target is unique within the batch).
  await q(
    `INSERT INTO pool_state_snapshots (pool_id, height, ts, reserve1, reserve2, ctl_supply)
     SELECT * FROM unnest($1::bigint[], $2::bigint[], $3::timestamptz[], $4::numeric[], $5::numeric[], $6::numeric[])
     ON CONFLICT (pool_id, ts) DO UPDATE SET
       height     = EXCLUDED.height,
       reserve1   = EXCLUDED.reserve1,
       reserve2   = EXCLUDED.reserve2,
       ctl_supply = EXCLUDED.ctl_supply`,
    [
      resolved.map((r) => r.poolId.toString()),
      resolved.map(() => headHeight),
      resolved.map(() => headTs),
      resolved.map((r) => r.p.reserve1.toString()),
      resolved.map((r) => r.p.reserve2.toString()),
      resolved.map((r) => r.p.ctl_supply.toString()),
    ],
  );

  logger.info({ height: headHeight, pools: pools.length }, 'pool state snapshot written');
  return pools;
}
