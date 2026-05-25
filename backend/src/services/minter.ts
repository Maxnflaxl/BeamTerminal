import { config } from '../config.js';
import { getContract, type Cell } from '../explorer.js';
import { q } from '../db.js';
import { logger } from '../logger.js';

// The contract uses UINT64_MAX as the "no cap" sentinel. We store NULL.
// Note: undici's body.json() routes through JSON.parse, which loses precision
// above 2^53. The sentinel (2^64-1) typically rounds *up* to 2^64 by the time
// it reaches us, so we threshold rather than equality-check.
const UINT64_MAX = (1n << 64n) - 1n;

function pickAid(cell: Cell): number | null {
  if (typeof cell === 'object' && cell !== null && !Array.isArray(cell)) {
    const v = cell as { type?: unknown; value?: unknown };
    if (v.type === 'aid' && typeof v.value === 'number') return v.value;
  }
  if (typeof cell === 'number') return cell;
  return null;
}

function pickAmount(cell: Cell): bigint | null {
  if (typeof cell === 'object' && cell !== null && !Array.isArray(cell)) {
    const v = cell as { type?: unknown; value?: unknown };
    if (v.type === 'amount') {
      const raw = v.value;
      if (typeof raw === 'string') {
        try { return BigInt(raw); } catch { return null; }
      }
      if (typeof raw === 'number') return BigInt(Math.trunc(raw));
    }
  }
  return null;
}

/**
 * Reads the Asset Minter contract's State.Tokens table and writes each row's
 * `Limit` to the corresponding asset's `max_supply`. Header on mainnet:
 *   [Aid, Metadata, Owner, Minted, Limit]
 *
 * Idempotent: only minter-issued assets are touched; the rest keep their
 * existing `max_supply` / `minter_cid` values. Limit=UINT64_MAX → NULL.
 *
 * Returns the number of asset rows updated. Returns 0 when ASSET_MINTER_CID
 * is unset (sync disabled).
 */
export async function syncMinterTokens(): Promise<number> {
  const cid = config.ASSET_MINTER_CID;
  if (!cid) return 0;

  const resp = await getContract({ id: cid, state: true, nMaxTxs: 0 });
  const tokens = resp.State?.Tokens;
  if (!tokens || typeof tokens !== 'object' || (tokens as { type?: unknown }).type !== 'table') {
    logger.warn({ cid }, 'minter sync: State.Tokens table missing');
    return 0;
  }
  const rows = (tokens as { value: ReadonlyArray<unknown> }).value;
  if (!Array.isArray(rows) || rows.length < 2) return 0;

  let updated = 0;
  // Skip header at index 0. Each data row: [Aid, Metadata, Owner, Minted, Limit].
  for (const row of rows.slice(1)) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const aid = pickAid(row[0] as Cell);
    const limit = pickAmount(row[4] as Cell);
    if (aid === null) continue;

    const maxSupply = limit === null || limit >= UINT64_MAX ? null : limit.toString();
    await q(
      `UPDATE assets
          SET minter_cid = $1,
              max_supply = $2
        WHERE aid = $3`,
      [cid, maxSupply, aid],
    );
    updated++;
  }

  logger.info({ updated, cid }, 'minter tokens synced');
  return updated;
}
