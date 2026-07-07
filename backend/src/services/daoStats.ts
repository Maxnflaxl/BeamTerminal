import { logger } from '../logger.js';
import { computeDaoTreasury } from '../api/repos/daoTreasury.js';
import { computeDaoRevenue } from '../api/repos/daoRevenue.js';
import { writeDaoStat } from '../api/repos/daoStatsCache.js';

// Recompute + cache the expensive DAO aggregates (treasury, revenue) into
// dao_stats. Kicked periodically from the indexer so the API serves the cache
// instead of re-scanning ~130k vault calls per request.
export async function refreshDaoStats(): Promise<void> {
  const t0 = Date.now();
  const [treasury, revenue] = await Promise.all([computeDaoTreasury(), computeDaoRevenue()]);
  await writeDaoStat('treasury', treasury);
  await writeDaoStat('revenue', revenue);
  logger.info({ ms: Date.now() - t0 }, 'dao_stats refreshed');
}
