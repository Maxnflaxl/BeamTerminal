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
 * Resolves the internal pool_id for a (aid1, aid2, kind) tuple, creating the
 * row if needed. Assets referenced in the tuple are also auto-created (with
 * minimal metadata — the assets catalog sync fills the rest).
 */
async function upsertPool(
  aid1: number,
  aid2: number,
  kind: 0 | 1 | 2,
  aid_ctl: number,
  createdAtHeight: number,
): Promise<bigint> {
  await ensureAssetExists(aid1, createdAtHeight);
  await ensureAssetExists(aid2, createdAtHeight);
  await ensureAssetExists(aid_ctl, createdAtHeight);

  const insert = await q<PoolRow>(
    `INSERT INTO pools (aid1, aid2, kind, aid_ctl, created_at_height)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (aid1, aid2, kind) DO UPDATE
       SET aid_ctl = EXCLUDED.aid_ctl
     RETURNING pool_id`,
    [aid1, aid2, kind, aid_ctl, createdAtHeight],
  );
  return BigInt(insert.rows[0]!.pool_id);
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

  for (const p of pools) {
    const poolId = await upsertPool(p.aid1, p.aid2, p.kind, p.aid_ctl, headHeight);

    await q(
      `INSERT INTO pool_state_snapshots (pool_id, height, ts, reserve1, reserve2, ctl_supply)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (pool_id, ts) DO UPDATE SET
         height     = EXCLUDED.height,
         reserve1   = EXCLUDED.reserve1,
         reserve2   = EXCLUDED.reserve2,
         ctl_supply = EXCLUDED.ctl_supply`,
      [poolId, headHeight, headTs, p.reserve1.toString(), p.reserve2.toString(), p.ctl_supply.toString()],
    );
  }

  logger.info({ height: headHeight, pools: pools.length }, 'pool state snapshot written');
  return pools;
}
