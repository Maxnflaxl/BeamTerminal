// Mirror of the backend response shapes from BeamTerminal/backend/src/api/routes.
// Kept hand-written so we can document field semantics for the UI.

/** One fee tier of a combined pair. Present in `ApiPair.tiers` only on grouped
 *  (combined-pair) responses; powers the detail-page tier switcher and the
 *  swap router's best-pool selection. `pool_id` is the tier's reference id;
 *  build its public id with `pairUrlId(aid1, aid2, kind)`. */
export interface ApiPairTier {
  pool_id: number;
  kind: 0 | 1 | 2;
  kind_label: string;
  lp_token: number;
  tvl_usd: number | null;
  volume_24h_usd: number | null;
  reserve1_human: number | null;
  reserve2_human: number | null;
  price_native: number | null;
}

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

  /** Present only on grouped (combined-pair) responses: one entry per fee tier,
   *  deepest first. Absent on single-tier responses. */
  tiers?: ApiPairTier[];
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
  /** 'pair' collapses fee tiers into one combined row per (aid1, aid2). */
  group?: 'tier' | 'pair';
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
  /** Signed share of the pool this event added/removed (Withdraw < 0). Null
   *  when no snapshot is available to size the pool. Present only in
   *  offset/`kind=lp` responses from a backend new enough to compute it. */
  liquidity_pct?: number | null;
  confirmed: boolean;
}

export interface ApiTradesList {
  trades: ApiTrade[];
  before: number | null;
  /** Offset-mode pagination metadata (present when requested via `offset`). */
  total?: number | null;
  offset?: number | null;
  limit?: number;
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

/** A single add/remove liquidity op, with the historical BEAM/USD price of each
 *  asset at the op's block height (null when no BEAM route exists). */
export interface ApiLpOp {
  kind: 'Deposit' | 'Withdraw';
  amount1: string;
  amount2: string;
  amount_ctl: string;
  height: number;
  ts: number; // unix seconds
  confirmed: boolean;
  beam_per_aid1: number | null;
  beam_per_aid2: number | null;
  usd_per_aid1: number | null;
  usd_per_aid2: number | null;
}

/** All add/remove ops for one pool, gathered from the user's reference list. */
export interface ApiPoolEvents {
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
  events: ApiLpOp[];
  // Present-time per-whole-unit prices, for valuing the still-in-pool remainder.
  current_beam_per_aid1: number | null;
  current_beam_per_aid2: number | null;
  current_usd_per_aid1: number | null;
  current_usd_per_aid2: number | null;
}

export interface ApiLpEventsResult {
  pools: ApiPoolEvents[];
  /** References (kernel ids / heights) that did not resolve to an indexed op. */
  unresolved: string[];
}

export interface ApiLpList {
  trades: ApiLpEvent[];
  before: number | null;
  total?: number | null;
  offset?: number | null;
  limit?: number;
}

/** Pool History series source + bucket width. */
export type LiquiditySource = 'total' | 'lp' | 'trades';
export type LiquidityInterval = '1h' | '1d';

export interface ApiPoolLiquidityPoint {
  ts: number; // unix seconds
  amount1: string; // groths of aid1
  amount2: string; // groths of aid2
}

export interface ApiPoolLiquidity {
  series: ApiPoolLiquidityPoint[];
  decimals1: number;
  decimals2: number;
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
  /** Brand colour from the OPT_COLOR metadata key (hex). Null when undefined. */
  color: string | null;
  /** Logo URL from the OPT_LOGO_URL metadata key (SVG vector). Null when undefined. */
  logo_url: string | null;
  /** Issuing contract CID when the asset is owned by a contract (DEX, Asset
   *  Minter, Nephrite, …). Null for wallet-issued assets and aid 0 (BEAM). */
  owner_cid: string | null;
  /** The issuing contract's explorer parser name ("DEX v0", "Nephrite v1",
   *  "Minter", …). Null when owner_cid is null or the contract is unknown. */
  owner_kind: string | null;
  /** Wallet owner-key for wallet-issued assets (shown as "Wallet (<key>)").
   *  Null for contract-issued assets and aid 0 (BEAM). */
  owner_addr: string | null;
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
  color: string | null;
  logo_url: string | null;
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
