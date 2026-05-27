// Mirror of the backend response shapes from BeamTerminal/backend/src/api/routes.
// Kept hand-written so we can document field semantics for the UI.

export interface ApiPair {
  pair_id: number;
  aid1: number;
  aid2: number;
  symbol1: string | null;
  symbol2: string | null;
  kind: 0 | 1 | 2;
  kind_label: string;
  decimals1: number;
  decimals2: number;

  price_native: number | null; // aid2 per 1 aid1
  price_usd: number | null; // USD per 1 aid2 unit
  rate_2_1: number | null; // 1 / price_native

  reserve1: string | null;
  reserve2: string | null;
  reserve1_human: number | null;
  reserve2_human: number | null;
  reserve1_usd: number | null;
  reserve2_usd: number | null;
  tvl_usd: number | null;

  /** Total LP-token supply (groths of lp_token) at the latest snapshot. */
  ctl_supply: string | null;
  /** Height of the snapshot reserves/ctl_supply are taken from. */
  snapshot_height: number | null;

  volume_24h_groth: string;
  volume_24h_usd: number | null;

  price_change_24h: number | null; // percent

  buys_24h: number;
  sells_24h: number;
  trades_24h: number;

  is_imposter: boolean;
  lp_token: number;
  created_at_height: number;

  /** Close prices over the last 7d (4h buckets, oldest → newest). May be empty. */
  sparkline_7d: number[];
}

export interface ApiStats {
  beam_usd: number | null;
  total_tvl_usd: number | null;
  volume_24h_usd: number | null;
  total_volume_usd: number | null;
  total_pairs: number;
  total_trades: number;
  last_indexed_height: number;
  block_ts: number | null;
}

export interface ApiPairsList {
  pairs: ApiPair[];
  total: number;
  last_indexed_height: number;
}

export type SortKey =
  | 'tvl_usd'
  | 'volume_24h_usd'
  | 'price_change_24h'
  | 'trades_24h'
  | 'aid2';
export type SortOrder = 'asc' | 'desc';

export interface PairsQuery {
  sort_by?: SortKey;
  order?: SortOrder;
  limit?: number;
  offset?: number;
  search?: string;
  kind?: 0 | 1 | 2;
  include_imposters?: boolean;
}

export type Interval = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';
export type Denom = 'native' | 'usd';

export interface ApiCandle {
  time: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: string; // groths of aid1 (string for safety)
  trade_count: number;
}

export interface ApiOhlcv {
  candles: ApiCandle[];
  interval: Interval;
  denom: Denom;
  more: { to: number } | null;
}

export interface ApiTrade {
  trade_id: number;
  timestamp: number; // unix seconds
  height: number;
  aid_in: number;
  aid_out: number;
  amount_in: string;
  amount_out: string;
  side: 'buy' | 'sell';
  price_native: number | null;
  price_usd: number | null;
  value_usd: number | null;
  confirmed: boolean;
  confirmations: number;
}

export interface ApiLpEvent {
  event_id: number;
  timestamp: number;
  height: number;
  kind: 'Deposit' | 'Withdraw';
  amount1: string;
  amount2: string;
  amount_ctl: string;
  confirmed: boolean;
}

export interface ApiTradesList {
  trades: ApiTrade[];
  before: number | null;
}

/** A Liquidity-Add deposit resolved from a kernel id or block height,
 *  plus the pool/asset metadata needed to analyse the position. */
export interface ApiDepositInfo {
  /** Public pair reference usable with api.pair(). */
  lp_token: number;
  pair_id: number;
  aid1: number;
  aid2: number;
  aid_ctl: number;
  symbol1: string | null;
  symbol2: string | null;
  decimals1: number;
  decimals2: number;
  kind: 0 | 1 | 2;
  kind_label: string;
  fee_pct: number;
  /** Magnitudes in groths (decimal strings). */
  amount1: string;
  amount2: string;
  amount_ctl: string;
  height: number;
  ts: number; // unix seconds
  confirmed: boolean;
}

/** Returned when a block height holds several deposits and the user must pick. */
export interface ApiDepositCandidates {
  candidates: ApiDepositInfo[];
}

export interface ApiLpList {
  trades: ApiLpEvent[];
  before: number | null;
}

export interface ApiAsset {
  aid: number;
  name: string | null;
  short_name: string | null;
  unit_name: string | null;
  description: string | null;
  decimals: number;
  is_imposter: boolean;
  emission: string | null;
  first_seen_height: number | null;
  // CID of the Beam Asset Minter that issued this asset (null = not minter-issued).
  minter_cid: string | null;
  // Configured supply cap in groths. Null = no cap (either non-minter asset
  // or minter's Limit is the UINT64_MAX "unlimited" sentinel).
  max_supply: string | null;
  pools: Array<{ pair_id: number; aid1: number; aid2: number; kind: number; tvl_usd: number | null }>;
}

export interface ApiAssetListEntry {
  aid: number;
  name: string | null;
  short_name: string | null;
  unit_name: string | null;
  description: string | null;
  decimals: number;
  is_imposter: boolean;
  imposter_reason: string | null;
  emission: string | null;
  first_seen_height: number | null;
  minter_cid: string | null;
  max_supply: string | null;
  pool_count: number;
}

export interface ApiAssetsList {
  assets: ApiAssetListEntry[];
}

export interface ApiAssetHistoryItem {
  height: number;
  ts: number | null;
  event: string;
  amount: string | null;
  total_amount: string | null;
  extra: string;
}

export interface ApiAssetHistory {
  aid: number;
  history: ApiAssetHistoryItem[];
  cached: boolean;
}

export interface ApiHealth {
  status: 'ok' | 'degraded';
  last_indexed_height: number;
  /** Chain head observed on the indexer's last tick. `null` until the
   *  indexer has stamped at least one tick post-migration 019. */
  chain_head: number | null;
  /** `chain_head - last_indexed_height` clamped to ≥0, or null if unknown. */
  blocks_behind: number | null;
  lag_seconds: number;
}
