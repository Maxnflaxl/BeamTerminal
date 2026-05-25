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

async function fetchJson<T>(path: string): Promise<T> {
  const url = `${config.EXPLORER_URL}${path}`;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const { statusCode, body } = await request(url, { method: 'GET' });
      if (statusCode >= 500) {
        lastErr = new Error(`HTTP ${statusCode} from ${url}`);
      } else if (statusCode >= 400) {
        // Non-retryable client error
        const text = await body.text();
        throw new Error(`HTTP ${statusCode} from ${url}: ${text.slice(0, 200)}`);
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
}

export async function getContract(query: ContractQuery): Promise<ContractResponse> {
  const params = new URLSearchParams();
  params.set('id', query.id);
  if (query.state !== undefined) params.set('state', query.state ? '1' : '0');
  if (query.hMin !== undefined) params.set('hMin', String(query.hMin));
  if (query.hMax !== undefined) params.set('hMax', String(query.hMax));
  if (query.nMaxTxs !== undefined) params.set('nMaxTxs', String(query.nMaxTxs));
  return fetchJson<ContractResponse>(`/contract?${params.toString()}`);
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
