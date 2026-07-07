import { loadDaoTreasury } from './daoTreasury.js';
import { loadDaoRevenue } from './daoRevenue.js';
import { loadDaoGovernance } from './daoGovernance.js';

// Hub summary: headline numbers from the three sections + a merged recent feed.

export interface DaoOverview {
  treasury: { value_usd: number; assets: number };
  revenue: { all_time_usd: number };
  governance: { current_epoch: number | null; active_proposals: number; turnout_pct: number | null };
  recent: Array<Record<string, unknown>>;
}

export async function loadDaoOverview(): Promise<DaoOverview> {
  const [t, r, g] = await Promise.all([loadDaoTreasury(), loadDaoRevenue(), loadDaoGovernance()]);
  const recent: Array<Record<string, unknown>> = [
    ...t.flows.slice(0, 5).map((f) => ({ kind: 'flow', height: f.height, ts: f.ts, method: f.method, funds: f.funds })),
    ...g.proposals.slice(0, 5).map((p) => ({ kind: 'proposal', id: p.id, epoch: p.epoch, title: p.title, outcome: p.outcome })),
  ];
  return {
    treasury: { value_usd: t.total_usd, assets: t.holdings.length },
    revenue: { all_time_usd: r.total_usd },
    governance: {
      current_epoch: g.current_epoch,
      active_proposals: g.kpis.active_proposals,
      turnout_pct: g.kpis.turnout_pct,
    },
    recent,
  };
}
