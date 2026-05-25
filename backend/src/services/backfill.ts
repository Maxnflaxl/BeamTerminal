import { config } from '../config.js';
import { getContracts } from '../explorer.js';
import { logger } from '../logger.js';

/**
 * Find the deploy height of `DEX_CID` by scanning the /contracts table.
 * Returns 0 if the contract isn't listed (caller falls back to "start from
 * tip minus a safety window").
 */
export async function findDexDeployHeight(): Promise<number> {
  const resp = await getContracts();
  if (resp.type !== 'table') return 0;

  for (const row of resp.value.slice(1)) {
    if (!Array.isArray(row) || row.length < 3) continue;
    const cidCell = row[0];
    const cid = typeof cidCell === 'object' && cidCell !== null
      ? (cidCell as { value?: unknown }).value
      : cidCell;
    if (typeof cid !== 'string') continue;
    if (cid.toLowerCase() !== config.DEX_CID.toLowerCase()) continue;

    // Deploy Height (third column): may be a typed {height} or a bare number.
    const dhCell = row[2];
    const dh =
      typeof dhCell === 'number'
        ? dhCell
        : typeof dhCell === 'object' && dhCell !== null
        ? Number((dhCell as { value?: unknown }).value)
        : Number(dhCell);
    if (Number.isFinite(dh) && dh > 0) {
      logger.info({ deploy_height: dh }, 'found DEX deploy height');
      return dh;
    }
  }

  logger.warn('DEX_CID not found in /contracts listing');
  return 0;
}
