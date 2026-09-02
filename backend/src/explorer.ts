import { request } from 'undici';
import { config } from './config.js';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Response shapes — modeled after live mainnet responses from explorer.0xmx.net.
// ---------------------------------------------------------------------------

export interface StatusResponse {
  chainwork: string;
  hash: string;
  height: number;
  low_horizon: number;
  peers_count: number;
  shielded_outputs_per_24h: number;
  shielded_outputs_total: number;
  shielded_possible_ready_in_hours: string;
  timestamp: number;
}

/**
 * The explorer's `/contract?id=…` response with `exp_am` / default mode.
 * Top-level keys observed live:
 *   - `kind`:       e.g. "Oracle2 v0", "DEX v0"
 *   - `h`:          current head height (mirrors /status.height)
 *   - `State`:      object map of contract-specific named sub-objects
 *   - `Locked Funds`, `Owned assets`, `Version History`: tables
 *   - `Calls history`: present only when `state=0` and `nMaxTxs>0`
 *
 * Values inside `State.<key>` can be either a plain primitive (string/number),
 * a typed cell, or a nested table. We type the container loosely and let
 * per-contract parsers narrow.
 */
export interface ContractResponse {
  kind?: string;
  h?: number;
  State?: Record<string, unknown>;
  'Locked Funds'?: Table;
  'Owned assets'?: Table;
  'Version History'?: Table;
  'Calls history'?: Table;
  [k: string]: unknown;
}

export interface Table {
  type: 'table';
  /** First entry is the header row of `{type:"th", value:string}` cells.
   *  Subsequent entries are data rows (arrays of mixed-typed cells) or
   *  `{type:"group", value:Row[]}` wrappers grouping a primary call + nested calls. */
  value: ReadonlyArray<Row | GroupRow>;
  /** Continuation cursor the explorer attaches when it cut the table short:
   *  the highest height *not* covered by this page. Absent when the page
   *  reached the end of the range. */
  more?: { hMax: number };
}

export type Row = ReadonlyArray<Cell>;

export interface GroupRow {
  type: 'group';
  value: ReadonlyArray<Row>;
}

export type Cell =
  | string
  | number
  | TypedCell
  | Table
  | Row /* nested row, rare */
  | null;

export type TypedCell =
  | { type: 'aid'; value: number }
  | { type: 'amount'; value: number | string }
  | { type: 'height'; value: number }
  | { type: 'cid'; value: string }
  | { type: 'blob'; value: string }
  | { type: 'th'; value: string };

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 250;

/** A non-2xx explorer response. Callers branch on `statusCode` (e.g. a 404
 *  marks a feature the explorer was built without) rather than on the text. */
export class ExplorerHttpError extends Error {
  readonly statusCode: number;
  readonly url: string;

  constructor(statusCode: number, url: string, detail?: string) {
    super(detail === undefined
      ? `HTTP ${statusCode} from ${url}`
      : `HTTP ${statusCode} from ${url}: ${detail}`);
    this.name = 'ExplorerHttpError';
    this.statusCode = statusCode;
    this.url = url;
  }
}

async function fetchJson<T>(path: string): Promise<T> {
  const url = `${config.EXPLORER_URL}${path}`;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const { statusCode, body } = await request(url, { method: 'GET' });
      if (statusCode >= 500) {
        lastErr = new ExplorerHttpError(statusCode, url);
      } else if (statusCode >= 400) {
        // Non-retryable client error
        const text = await body.text();
        throw new ExplorerHttpError(statusCode, url, text.slice(0, 200));
      } else {
        return (await body.json()) as T;
      }
    } catch (err) {
      lastErr = err;
    }

    if (attempt < MAX_ATTEMPTS) {
      const delay = BASE_BACKOFF_MS * 2 ** (attempt - 1);
      logger.warn({ url, attempt, delay }, 'explorer request failed; retrying');
      await sleep(delay);
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function getStatus(): Promise<StatusResponse> {
  return fetchJson<StatusResponse>('/status');
}

export interface ContractQuery {
  id: string;
  /** Include the parsed contract state in the response (default true). */
  state?: boolean;
  /** Lower height bound (inclusive) for the "Calls history" table. */
  hMin?: number;
  /** Upper height bound (inclusive). */
  hMax?: number;
  /** Max number of call entries returned (set to 0 to skip the call list entirely). */
  nMaxTxs?: number;
  /** Format `amount` cells as human-readable decimal strings (e.g.
   *  "60,011,001.00000000") instead of raw groth integers. Also what the
   *  explorer's own contract page uses for its Locked Funds / Funds tables. */
  exp_am?: boolean;
}

export async function getContract(query: ContractQuery): Promise<ContractResponse> {
  const params = new URLSearchParams();
  params.set('id', query.id);
  if (query.state !== undefined) params.set('state', query.state ? '1' : '0');
  if (query.hMin !== undefined) params.set('hMin', String(query.hMin));
  if (query.hMax !== undefined) params.set('hMax', String(query.hMax));
  if (query.nMaxTxs !== undefined) params.set('nMaxTxs', String(query.nMaxTxs));
  if (query.exp_am) params.set('exp_am', '1');
  return fetchJson<ContractResponse>(`/contract?${params.toString()}`);
}

/**
 * The explorer clamps `nMaxTxs` to 2000 entries per response
 * (`get_ContractState`, adapter.cpp), so any contract with a longer history
 * comes back cut off — silently, apart from the `more.hMax` cursor it attaches
 * to the table. A caller that needs the *whole* history (a running balance, a
 * height resolver that maps arbitrarily old messages) gets a wrong answer from
 * a single fetch, and nothing in the payload it parses says so.
 */
function callsMore(resp: ContractResponse): { hMax: number } | undefined {
  // The marker sits on the table; older explorer builds put it at the top
  // level, and the two cost the same to check.
  return resp['Calls history']?.more ?? (resp as { more?: { hMax: number } }).more;
}

/**
 * Page budget for a whole-history walk. Each page is the explorer's own
 * 2000-entry ceiling, so this covers 200k calls — orders of magnitude past any
 * contract we read whole, while still bounding a runaway cursor.
 */
const MAX_CALL_PAGES = 100;

/**
 * `getContract`, following the `more.hMax` cursor until the call history is
 * complete. Returns one response whose `Calls history` holds every page's rows
 * in the explorer's own order (newest height first); every other section is the
 * first page's, i.e. the head state.
 *
 * The returned table keeps a `more` marker only when the walk gave up — the
 * page budget ran out, or the cursor stopped retreating — so callers that
 * cannot tolerate a partial history can still detect one.
 */
export async function getContractFullHistory(query: ContractQuery): Promise<ContractResponse> {
  const head = await getContract(query);
  const table = head['Calls history'];
  if (!table?.value) return head;

  const header = table.value[0];
  const rows: Array<Row | GroupRow> = [...table.value.slice(1)];
  let cursor = callsMore(head)?.hMax;
  let pages = 1;
  let truncated = false;

  while (cursor !== undefined) {
    // The cursor is the next height to look *at or below*; once it drops under
    // the caller's floor there is nothing left in range to ask for.
    if (query.hMin !== undefined && cursor < query.hMin) break;
    if (pages >= MAX_CALL_PAGES) {
      logger.error({ cid: query.id, pages, cursor }, 'explorer: call history exceeded the page budget');
      truncated = true;
      break;
    }
    // eslint-disable-next-line no-await-in-loop
    const page = await getContract({ ...query, hMax: cursor });
    pages += 1;
    for (const row of page['Calls history']?.value.slice(1) ?? []) rows.push(row);

    const next = callsMore(page)?.hMax;
    if (next === undefined) break;
    if (next >= cursor) {
      // A cursor that doesn't retreat would re-read the same page forever, and
      // the rows it returned are already in `rows`.
      logger.error({ cid: query.id, cursor, next }, 'explorer: call history cursor did not advance');
      truncated = true;
      break;
    }
    cursor = next;
  }

  const merged: Table = { type: 'table', value: [...(header ? [header] : []), ...rows] };
  if (truncated) merged.more = { hMax: cursor! };
  return { ...head, 'Calls history': merged };
}

/**
 * Single block lookup. Returns the legacy-JSON block object.
 * `found: false` means the height isn't on the active chain (e.g. above tip).
 */
export interface BlockResponse {
  found: boolean;
  height: number;
  h?: number;
  hash?: string;
  prev?: string;
  timestamp?: number;
  inputs?: ReadonlyArray<unknown>;
  outputs?: ReadonlyArray<unknown>;
  kernels?: ReadonlyArray<unknown>;
  subsidy?: number;
  difficulty?: number;
  chainwork?: string;
  rate_btc?: string;
  rate_usd?: string;
}

export async function getBlock(query: { height: number } | { kernel: string }): Promise<BlockResponse> {
  const params = new URLSearchParams();
  if ('height' in query) {
    params.set('height', String(query.height));
  } else {
    params.set('kernel', query.kernel);
  }
  return fetchJson<BlockResponse>(`/block?${params.toString()}`);
}

/**
 * Asset registry snapshot.
 *
 * Live response (mainnet):
 *   { type: "table", h: <height>,
 *     value: [
 *       [{th:"Aid"},{th:"Owner"},{th:"Deposit"},{th:"Supply"},{th:"Lock height"},{th:"Metadata"}],
 *       [{aid:N}, {blob:"…"}|"", {amount:"…"}, {amount:"…"}, <lockHeight>, "STD:…"],
 *       …
 *     ]
 *   }
 */
export interface AssetsResponse {
  type: 'table';
  h?: number;
  value: ReadonlyArray<Row>;
}

export async function getAssets(query: { height?: number } = {}): Promise<AssetsResponse> {
  const params = new URLSearchParams();
  if (query.height !== undefined) params.set('height', String(query.height));
  const qs = params.toString();
  return fetchJson<AssetsResponse>(qs ? `/assets?${qs}` : '/assets');
}

/**
 * Catalog of deployed contracts. Used during backfill to find when DEX_CID was first deployed.
 *
 * Response is a table with header `[Cid, Kind, Deploy Height, Locked Funds, Owned Assets]`.
 */
export interface ContractsResponse {
  type: 'table';
  h?: number;
  value: ReadonlyArray<Row>;
}

export async function getContracts(): Promise<ContractsResponse> {
  return fetchJson<ContractsResponse>('/contracts');
}

/**
 * Per-asset history (mint/burn/create/destroy events).
 *
 * Live shape (mainnet):
 *   { "Asset history":     {type:"table", value:[<header>, [<height>, <event>, {amount}, {total}, <extra>], …]},
 *     "Asset distribution":{type:"table", value:[…]} }
 *
 * Header columns: Height, Event, Amount, Total Amount, Extra.
 * Note: `id` must be non-zero — explorer's adapter rejects aid 0 (BEAM).
 */
export interface AssetHistoryResponse {
  'Asset history'?: Table;
  'Asset distribution'?: Table;
}

export async function getAssetHistory(query: {
  id: number;
  hMin?: number;
  hMax?: number;
  nMaxOps?: number;
}): Promise<AssetHistoryResponse> {
  const params = new URLSearchParams();
  params.set('id', String(query.id));
  if (query.hMin !== undefined) params.set('hMin', String(query.hMin));
  if (query.hMax !== undefined) params.set('hMax', String(query.hMax));
  if (query.nMaxOps !== undefined) params.set('nMaxOps', String(query.nMaxOps));
  return fetchJson<AssetHistoryResponse>(`/asset?${params.toString()}`);
}

/**
 * Atomic swap offers — cross-chain swap offers (BEAM ↔ BTC/LTC/...).
 *
 * Only present when the explorer node was built with `BEAM_ATOMIC_SWAP_SUPPORT`.
 * The public explorer.0xmx.net build does include it; older / minimal explorer
 * builds return 404. Callers should treat 404 as "feature unavailable" rather
 * than a hard error.
 *
 * Shape per docs-gitbook/core-tech/api/Beam-Node-Explorer-API.md and
 * beam/explorer/adapter.cpp::get_swap_offers.
 */
export interface SwapOffer {
  status: number;
  status_string: string;
  txId: string;
  beam_amount: string;
  swap_amount: string;
  /** Build-dependent integer enum; map in services/atomicSwaps.ts. */
  swap_currency: string | number;
  time_created: string;
  min_height: number;
  height_expired: number;
  is_beam_side: boolean;
}

export async function getSwapOffers(): Promise<SwapOffer[]> {
  return fetchJson<SwapOffer[]>('/swap_offers');
}

/**
 * Aggregated cross-chain swap totals. All amounts are decimal strings.
 *
 * Field ordering matches the explorer's JSON keys (BTC, LTC, QTUM, DOGE, DASH,
 * ETH, DAI, USDT, WBTC), which is the same ordering as the swap_currency enum
 * in wallet/transactions/swaps/common.cpp.
 */
export interface SwapTotalsResponse {
  total_swaps_count: number;
  beams_offered: string;
  bitcoin_offered: string;
  litecoin_offered: string;
  qtum_offered: string;
  dogecoin_offered: string;
  dash_offered: string;
  ethereum_offered: string;
  dai_offered: string;
  usdt_offered: string;
  wbtc_offered: string;
}

export async function getSwapTotals(): Promise<SwapTotalsResponse> {
  return fetchJson<SwapTotalsResponse>('/swap_totals');
}

/**
 * DEX-style asset-to-asset swap offers, live from the explorer node
 * (BeamMW/beam #2054, gated behind `BEAM_ASSET_SWAP_SUPPORT`). These are the
 * same wallet-gossiped orders the wallet-api's `assets_swap_offers_list` used
 * to serve — the explorer now exposes them directly, so we no longer need the
 * wallet daemon for asset swaps.
 *
 * Maker perspective: `send_*` is what the maker offers, `receive_*` what they
 * want. Amounts are formatted decimal strings *with thousands separators*
 * (e.g. "10,624.16998671"), rendered with each asset's own decimals — convert
 * back to atomic units in services/assetSwapOffers.ts. The explorer has no
 * wallet, so there is no `isMy` field (every offer is "not mine").
 *
 * Like /swap_offers, only present on explorer builds compiled with the swap
 * feature flag; a 404 means "feature unavailable" and should be treated as an
 * empty list rather than a hard error.
 *
 * Shape per beam/explorer/adapter.cpp::get_asset_swaps.
 */
export interface AssetSwapOfferRaw {
  id: string;
  create_time: number;
  expire_time: number;
  send_asset_id: number;
  send_amount: string;
  send_currency: string;
  receive_asset_id: number;
  receive_amount: string;
  receive_currency: string;
}

export async function getAssetSwaps(): Promise<AssetSwapOfferRaw[]> {
  return fetchJson<AssetSwapOfferRaw[]>('/asset_swaps');
}
