// Tiny fetch wrapper for /api/*. Same-origin in prod (nginx proxies /api),
// proxied via webpack dev-server in dev.
//
// All endpoints are open + GET-only — no auth headers.

import type {
  ApiHealth,
  ApiStats,
  ApiMiningPools,
  ApiMiningBlocks,
  ApiNetwork,
  ApiBansActions,
  ApiDaoOverview,
  ApiDaoTreasury,
  ApiDaoAssetHistory,
  ApiDaoRevenue,
  ApiDaoGovernance,
  ApiDaoProposalDetail,
  ApiPair,
  ApiPairsList,
  ApiOhlcv,
  ApiTradesList,
  ApiLpList,
  ApiPoolLiquidity,
  ApiDepositInfo,
  ApiDepositCandidates,
  ApiLpEventsResult,
  ApiAsset,
  ApiAssetsList,
  ApiAssetHistory,
  ApiAssetDistribution,
  ApiAssetSwapsList,
  ApiAtomicSwapsList,
  ApiAtomicSwapTotalsLatest,
  ApiAtomicSwapTotalsHistory,
  ApiDappsList,
  ApiDappDetail,
  ApiDappPublishersList,
  ApiDappRawCallsList,
  ApiSearch,
  PairsQuery,
  Interval,
  Denom,
  LiquiditySource,
  LiquidityInterval,
} from './types';

// Same-origin on the public site (nginx serves /api next to the bundle).
// Everywhere else the page origin has no /api of its own — the wallet's
// http://127.0.0.1:<port> .dapp host and the local dev server — so those
// use the absolute prod host.
const BASE = window.location.hostname === 'beamterminal.0xmx.net' ? '/api' : 'https://beamterminal.0xmx.net/api';

class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

// Concurrent GETs for the same path share one request — e.g. the two pair-page
// banners resolve both pool assets in the same poll tick.
const inflight = new Map<string, Promise<unknown>>();

async function get<T>(path: string): Promise<T> {
  const existing = inflight.get(path);
  if (existing) return existing as Promise<T>;
  const p = (async () => {
    const res = await fetch(`${BASE}${path}`, {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
    if (!res.ok) {
      let code = 'HTTP_ERROR';
      let msg = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { error?: { code: string; message: string } };
        if (body.error) {
          code = body.error.code;
          msg = body.error.message;
        }
      } catch {
        /* ignore */
      }
      throw new ApiError(res.status, code, msg);
    }
    return (await res.json()) as T;
  })();
  inflight.set(path, p);
  try {
    return (await p) as T;
  } finally {
    inflight.delete(path);
  }
}

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    out.set(k, String(v));
  }
  const s = out.toString();
  return s ? `?${s}` : '';
}

export const api = {
  health: (): Promise<ApiHealth> => get<ApiHealth>('/health'),
  stats: (): Promise<ApiStats> => get<ApiStats>('/stats'),
  miningPools: (): Promise<ApiMiningPools> => get<ApiMiningPools>('/mining/pools'),
  network: (): Promise<ApiNetwork> => get<ApiNetwork>('/network'),
  bansActions: (): Promise<ApiBansActions> => get<ApiBansActions>('/bans/actions'),
  daoOverview: (): Promise<ApiDaoOverview> => get<ApiDaoOverview>('/dao/overview'),
  daoTreasury: (): Promise<ApiDaoTreasury> => get<ApiDaoTreasury>('/dao/treasury'),
  daoTreasuryAsset: (aid: number, limit = 100): Promise<ApiDaoAssetHistory> =>
    get<ApiDaoAssetHistory>(`/dao/treasury/asset/${aid}?limit=${limit}`),
  daoRevenue: (groupBy: 'source' | 'pool' | 'tier' | 'asset' = 'source'): Promise<ApiDaoRevenue> =>
    get<ApiDaoRevenue>(`/dao/revenue?groupBy=${groupBy}`),
  daoGovernance: (): Promise<ApiDaoGovernance> => get<ApiDaoGovernance>('/dao/governance'),
  daoProposal: (id: number, offset = 0, limit = 25): Promise<ApiDaoProposalDetail> =>
    get<ApiDaoProposalDetail>(`/dao/governance/proposals/${id}?offset=${offset}&limit=${limit}`),
  miningBlocks: (limit = 50, offset = 0): Promise<ApiMiningBlocks> =>
    get<ApiMiningBlocks>(`/mining/blocks?limit=${limit}&offset=${offset}`),

  pairs: (params: PairsQuery = {}): Promise<ApiPairsList> =>
    get<ApiPairsList>(`/pairs${qs(params as Record<string, string | number | boolean | undefined>)}`),

  pair: (id: string | number): Promise<ApiPair> => get<ApiPair>(`/pairs/${id}`),

  ohlcv: (
    id: string | number,
    opts: { interval?: Interval; limit?: number; to?: number; denom?: Denom } = {},
  ): Promise<ApiOhlcv> => get<ApiOhlcv>(`/pairs/${id}/ohlcv${qs(opts)}`),

  trades: (
    id: string | number,
    opts: { limit?: number; before?: number; offset?: number; count?: boolean; include_unconfirmed?: boolean } = {},
  ): Promise<ApiTradesList> => get<ApiTradesList>(`/pairs/${id}/trades${qs({ ...opts, kind: 'Trade' })}`),

  lpEvents: (
    id: string | number,
    opts: { limit?: number; before?: number; offset?: number; count?: boolean } = {},
  ): Promise<ApiLpList> => get<ApiLpList>(`/pairs/${id}/trades${qs({ ...opts, kind: 'lp' })}`),

  poolLiquidity: (
    id: string | number,
    opts: { source?: LiquiditySource; interval?: LiquidityInterval; from?: number; to?: number } = {},
  ): Promise<ApiPoolLiquidity> => get<ApiPoolLiquidity>(`/pairs/${id}/liquidity${qs(opts)}`),

  // Resolve a Liquidity-Add deposit by kernel id or block height. Returns a
  // single ApiDepositInfo, or { candidates } when a height has several deposits.
  lpPosition: {
    deposit: (params: { kernel?: string; height?: number }): Promise<ApiDepositInfo | ApiDepositCandidates> =>
      get<ApiDepositInfo | ApiDepositCandidates>(`/lp-position/deposit${qs(params)}`),
    // Multi-ref lookup: `refs` is heights and/or kernel ids, comma/space-separated.
    events: (refs: string): Promise<ApiLpEventsResult> => get<ApiLpEventsResult>(`/lp-position/events${qs({ refs })}`),
  },

  asset: (aid: number): Promise<ApiAsset> => get<ApiAsset>(`/asset/${aid}`),

  assets: (): Promise<ApiAssetsList> => get<ApiAssetsList>('/assets'),

  assetHistory: (aid: number, limit = 100): Promise<ApiAssetHistory> =>
    get<ApiAssetHistory>(`/asset/${aid}/history${qs({ limit })}`),

  assetDistribution: (aid: number): Promise<ApiAssetDistribution> =>
    get<ApiAssetDistribution>(`/asset/${aid}/distribution`),

  // Wallet-gossiped DEX-style asset-to-asset offers (from wallet-api).
  assetSwaps: (
    opts: { include?: 'closed' | 'all'; send?: number; receive?: number } = {},
  ): Promise<ApiAssetSwapsList> => get<ApiAssetSwapsList>(`/asset-swaps${qs(opts)}`),

  // Cross-chain atomic-swap offers (from explorer /swap_offers).
  atomicSwaps: (
    opts: { include?: 'closed' | 'all'; currency?: string; side?: 'beam' | 'counter' } = {},
  ): Promise<ApiAtomicSwapsList> => get<ApiAtomicSwapsList>(`/atomic-swaps${qs(opts)}`),

  atomicSwapTotals: (): Promise<ApiAtomicSwapTotalsLatest> => get<ApiAtomicSwapTotalsLatest>('/atomic-swaps/totals'),

  atomicSwapTotalsHistory: (
    opts: { since?: string; bucket?: '15m' | '1h' | '1d' } = {},
  ): Promise<ApiAtomicSwapTotalsHistory> => get<ApiAtomicSwapTotalsHistory>(`/atomic-swaps/totals/history${qs(opts)}`),

  dapps: (opts: { include_deleted?: boolean } = {}): Promise<ApiDappsList> => {
    const flags: Record<string, string | number | boolean | undefined> = {};
    if (opts.include_deleted) flags.include_deleted = 1;
    return get<ApiDappsList>(`/dapps${qs(flags)}`);
  },

  dapp: (id: string): Promise<ApiDappDetail> => get<ApiDappDetail>(`/dapps/${encodeURIComponent(id)}`),

  dappPublishers: (): Promise<ApiDappPublishersList> => get<ApiDappPublishersList>('/dapps/publishers'),

  dappRawCalls: (opts: { limit?: number; action?: number } = {}): Promise<ApiDappRawCallsList> =>
    get<ApiDappRawCallsList>(`/dapps/calls${qs(opts)}`),

  search: (query: string): Promise<ApiSearch> => get<ApiSearch>(`/search?q=${encodeURIComponent(query)}`),

  charts: {
    hashrate: (o: { res?: ChartRes; from?: number; to?: number } = {}) =>
      get<ApiChartSeries>(`/charts/hashrate${qs(o)}`),
    coinbase: (o: { res?: ChartRes; from?: number; to?: number } = {}) =>
      get<ApiChartSeries>(`/charts/coinbase${qs(o)}`),
    assets: (o: { res?: ChartRes; from?: number; to?: number } = {}) => get<ApiChartSeries>(`/charts/assets${qs(o)}`),
    dexVolume: (o: { res?: ChartRes; from?: number; to?: number } = {}) =>
      get<ApiChartSeries>(`/charts/dex-volume${qs(o)}`),
    difficulty: (o: { res?: ChartRes; from?: number; to?: number } = {}) =>
      get<ApiChartSeries>(`/charts/difficulty${qs(o)}`),
    price: (o: { res?: ChartRes; from?: number; to?: number } = {}) => get<ApiChartSeries>(`/charts/price${qs(o)}`),
    blockTime: (o: { res?: ChartRes; from?: number; to?: number } = {}) =>
      get<ApiChartSeries>(`/charts/block-time${qs(o)}`),
    tvl: (o: { res?: ChartRes; from?: number; to?: number } = {}) => get<ApiChartSeries>(`/charts/tvl${qs(o)}`),
    poolsCreated: (): Promise<ApiChartSeries> => get<ApiChartSeries>('/charts/pools-created'),
    poolsClosed: (): Promise<ApiChartSeries> => get<ApiChartSeries>('/charts/pools-closed'),
    beamVol: (): Promise<ApiChartSeries> => get<ApiChartSeries>('/charts/beam-vol'),
    dexVol: (): Promise<ApiChartSeries> => get<ApiChartSeries>('/charts/dex-vol'),
    transactionsDaily: (o: { res?: ChartRes; from?: number; to?: number } = {}) =>
      get<ApiChartSeries>(`/charts/transactions-daily${qs(o)}`),
    transactionsTotal: (o: { res?: ChartRes; from?: number; to?: number } = {}) =>
      get<ApiChartSeries>(`/charts/transactions-total${qs(o)}`),
    txosTotal: (o: { res?: ChartRes; from?: number; to?: number } = {}) =>
      get<ApiChartSeries>(`/charts/txos-total${qs(o)}`),
    utxosTotal: (o: { res?: ChartRes; from?: number; to?: number } = {}) =>
      get<ApiChartSeries>(`/charts/utxos-total${qs(o)}`),
    sizeTotal: (o: { res?: ChartRes; from?: number; to?: number } = {}) =>
      get<ApiChartSeries>(`/charts/size-total${qs(o)}`),
    archiveTotal: (o: { res?: ChartRes; from?: number; to?: number } = {}) =>
      get<ApiChartSeries>(`/charts/archive-total${qs(o)}`),
    shieldedInsDaily: (o: { res?: ChartRes; from?: number; to?: number } = {}) =>
      get<ApiChartSeries>(`/charts/shielded-ins-daily${qs(o)}`),
    shieldedInsTotal: (o: { res?: ChartRes; from?: number; to?: number } = {}) =>
      get<ApiChartSeries>(`/charts/shielded-ins-total${qs(o)}`),
    shieldedOutsDaily: (o: { res?: ChartRes; from?: number; to?: number } = {}) =>
      get<ApiChartSeries>(`/charts/shielded-outs-daily${qs(o)}`),
    shieldedOutsTotal: (o: { res?: ChartRes; from?: number; to?: number } = {}) =>
      get<ApiChartSeries>(`/charts/shielded-outs-total${qs(o)}`),
    contractsTotal: (o: { res?: ChartRes; from?: number; to?: number } = {}) =>
      get<ApiChartSeries>(`/charts/contracts-total${qs(o)}`),
    feesDaily: (o: { res?: ChartRes; from?: number; to?: number } = {}) =>
      get<ApiChartSeries>(`/charts/fees-daily${qs(o)}`),
    feesTotal: (o: { res?: ChartRes; from?: number; to?: number } = {}) =>
      get<ApiChartSeries>(`/charts/fees-total${qs(o)}`),
    contractCallsDaily: (o: { res?: ChartRes; from?: number; to?: number } = {}) =>
      get<ApiChartSeries>(`/charts/contract-calls-daily${qs(o)}`),
    contractCallsTotal: (o: { res?: ChartRes; from?: number; to?: number } = {}) =>
      get<ApiChartSeries>(`/charts/contract-calls-total${qs(o)}`),
    // Multi-series: cumulative locked balance per asset in the BlackHole contract.
    blackhole: (): Promise<ApiBlackholeBody> => get<ApiBlackholeBody>('/charts/blackhole'),
  },
};

export type ChartRes = '1m' | '1h' | '1d';

export interface ApiChartPoint {
  ts: number;
  value: number;
}
export interface ApiChartSeries {
  series: ApiChartPoint[];
}

// One line per asset locked in the BlackHole burn contract. `value` is the
// asset's cumulative locked balance in native units; `color` is the asset's
// brand colour (OPT_COLOR) when known, else null (the chart assigns a fallback).
export interface ApiBlackholeSeries {
  aid: number;
  label: string;
  color: string | null;
  points: ApiChartPoint[];
}
export interface ApiBlackholeBody {
  series: ApiBlackholeSeries[];
}

export { ApiError };
