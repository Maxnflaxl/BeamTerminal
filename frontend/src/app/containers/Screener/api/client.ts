// Tiny fetch wrapper for /api/*. Same-origin in prod (nginx proxies /api),
// proxied via webpack dev-server in dev.
//
// All endpoints are open + GET-only — no auth headers.

import type {
  ApiHealth,
  ApiStats,
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
  ApiAssetSwapsList,
  ApiAtomicSwapsList,
  ApiAtomicSwapTotalsLatest,
  ApiAtomicSwapTotalsHistory,
  ApiDappsList,
  ApiDappDetail,
  ApiDappPublishersList,
  ApiDappRawCallsList,
  PairsQuery,
  Interval,
  Denom,
  LiquiditySource,
  LiquidityInterval,
} from './types';

const BASE = 'https://beamterminal.0xmx.net/api';

class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

async function get<T>(path: string): Promise<T> {
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

  pairs: (params: PairsQuery = {}): Promise<ApiPairsList> => get<ApiPairsList>(`/pairs${qs(params as Record<string, string | number | boolean | undefined>)}`),

  pair: (id: string | number): Promise<ApiPair> => get<ApiPair>(`/pairs/${id}`),

  ohlcv: (id: string | number, opts: { interval?: Interval; limit?: number; to?: number; denom?: Denom } = {}): Promise<ApiOhlcv> => get<ApiOhlcv>(`/pairs/${id}/ohlcv${qs(opts)}`),

  trades: (id: string | number, opts: { limit?: number; before?: number; offset?: number; count?: boolean; include_unconfirmed?: boolean } = {}): Promise<ApiTradesList> => get<ApiTradesList>(`/pairs/${id}/trades${qs({ ...opts, kind: 'Trade' })}`),

  lpEvents: (id: string | number, opts: { limit?: number; before?: number; offset?: number; count?: boolean } = {}): Promise<ApiLpList> => get<ApiLpList>(`/pairs/${id}/trades${qs({ ...opts, kind: 'lp' })}`),

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
    events: (refs: string): Promise<ApiLpEventsResult> =>
      get<ApiLpEventsResult>(`/lp-position/events${qs({ refs })}`),
  },

  asset: (aid: number): Promise<ApiAsset> => get<ApiAsset>(`/asset/${aid}`),

  assets: (): Promise<ApiAssetsList> => get<ApiAssetsList>('/assets'),

  assetHistory: (aid: number, limit = 100): Promise<ApiAssetHistory> => get<ApiAssetHistory>(`/asset/${aid}/history${qs({ limit })}`),

  // Wallet-gossiped DEX-style asset-to-asset offers (from wallet-api).
  assetSwaps: (
    opts: { include?: 'closed' | 'all'; send?: number; receive?: number } = {},
  ): Promise<ApiAssetSwapsList> => get<ApiAssetSwapsList>(`/asset-swaps${qs(opts)}`),

  // Cross-chain atomic-swap offers (from explorer /swap_offers).
  atomicSwaps: (
    opts: { include?: 'closed' | 'all'; currency?: string; side?: 'beam' | 'counter' } = {},
  ): Promise<ApiAtomicSwapsList> => get<ApiAtomicSwapsList>(`/atomic-swaps${qs(opts)}`),

  atomicSwapTotals: (): Promise<ApiAtomicSwapTotalsLatest> =>
    get<ApiAtomicSwapTotalsLatest>('/atomic-swaps/totals'),

  atomicSwapTotalsHistory: (
    opts: { since?: string; bucket?: '15m' | '1h' | '1d' } = {},
  ): Promise<ApiAtomicSwapTotalsHistory> =>
    get<ApiAtomicSwapTotalsHistory>(`/atomic-swaps/totals/history${qs(opts)}`),

  dapps: (opts: { include_deleted?: boolean } = {}): Promise<ApiDappsList> => {
    const flags: Record<string, string | number | boolean | undefined> = {};
    if (opts.include_deleted) flags.include_deleted = 1;
    return get<ApiDappsList>(`/dapps${qs(flags)}`);
  },

  dapp: (id: string): Promise<ApiDappDetail> => get<ApiDappDetail>(`/dapps/${encodeURIComponent(id)}`),

  dappPublishers: (): Promise<ApiDappPublishersList> => get<ApiDappPublishersList>('/dapps/publishers'),

  dappRawCalls: (
    opts: { limit?: number; action?: number } = {},
  ): Promise<ApiDappRawCallsList> =>
    get<ApiDappRawCallsList>(`/dapps/calls${qs(opts)}`),

  charts: {
    hashrate:   (): Promise<ApiChartSeries> => get<ApiChartSeries>('/charts/hashrate'),
    coinbase:   (): Promise<ApiChartSeries> => get<ApiChartSeries>('/charts/coinbase'),
    assets:     (): Promise<ApiChartSeries> => get<ApiChartSeries>('/charts/assets'),
    dexVolume:  (): Promise<ApiChartSeries> => get<ApiChartSeries>('/charts/dex-volume'),
    difficulty: (): Promise<ApiChartSeries> => get<ApiChartSeries>('/charts/difficulty'),
    blockTime:  (): Promise<ApiChartSeries> => get<ApiChartSeries>('/charts/block-time'),
    tvl:        (): Promise<ApiChartSeries> => get<ApiChartSeries>('/charts/tvl'),
    beamVol:    (): Promise<ApiChartSeries> => get<ApiChartSeries>('/charts/beam-vol'),
    dexVol:     (): Promise<ApiChartSeries> => get<ApiChartSeries>('/charts/dex-vol'),
    transactionsDaily:   (): Promise<ApiChartSeries> => get<ApiChartSeries>('/charts/transactions-daily'),
    transactionsTotal:   (): Promise<ApiChartSeries> => get<ApiChartSeries>('/charts/transactions-total'),
    txosTotal:           (): Promise<ApiChartSeries> => get<ApiChartSeries>('/charts/txos-total'),
    utxosTotal:          (): Promise<ApiChartSeries> => get<ApiChartSeries>('/charts/utxos-total'),
    shieldedInsDaily:    (): Promise<ApiChartSeries> => get<ApiChartSeries>('/charts/shielded-ins-daily'),
    shieldedInsTotal:    (): Promise<ApiChartSeries> => get<ApiChartSeries>('/charts/shielded-ins-total'),
    shieldedOutsDaily:   (): Promise<ApiChartSeries> => get<ApiChartSeries>('/charts/shielded-outs-daily'),
    shieldedOutsTotal:   (): Promise<ApiChartSeries> => get<ApiChartSeries>('/charts/shielded-outs-total'),
    contractsTotal:      (): Promise<ApiChartSeries> => get<ApiChartSeries>('/charts/contracts-total'),
    feesDaily:           (): Promise<ApiChartSeries> => get<ApiChartSeries>('/charts/fees-daily'),
    feesTotal:           (): Promise<ApiChartSeries> => get<ApiChartSeries>('/charts/fees-total'),
    contractCallsDaily:  (): Promise<ApiChartSeries> => get<ApiChartSeries>('/charts/contract-calls-daily'),
    contractCallsTotal:  (): Promise<ApiChartSeries> => get<ApiChartSeries>('/charts/contract-calls-total'),
  },
};

export interface ApiChartPoint { ts: number; value: number }
export interface ApiChartSeries { series: ApiChartPoint[] }

export { ApiError };
