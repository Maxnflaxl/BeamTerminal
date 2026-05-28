import { request } from 'undici';
import { config } from './config.js';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Minimal JSON-RPC client for the BEAM wallet-api daemon.
//
// We only call methods marked `API_READ_ACCESS` in the wallet-api method
// registration tables (see beam/wallet/api/v7_*/v7_*_api_defs.h). For the
// asset-swaps subsystem that's exactly one method: `assets_swap_offers_list`.
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 250;

interface JsonRpcResult<T> {
  jsonrpc: '2.0';
  id: number | string;
  result?: T;
  // `assets_swap_offers_list` returns `{ id, jsonrpc, offers: [...] }` —
  // i.e. the payload is hoisted to the top level instead of nested under
  // `result`. Pinned: see beam/wallet/api/v7_2/v7_2_api_impl.cpp.
  offers?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class WalletApiUnavailableError extends Error {
  constructor() {
    super('WALLET_API_URL is not set; wallet-api features are disabled');
  }
}

let nextId = 1;

async function call<T>(method: string, params?: Record<string, unknown>): Promise<JsonRpcResult<T>> {
  if (!config.WALLET_API_URL) {
    throw new WalletApiUnavailableError();
  }
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: nextId++,
    method,
    ...(params ? { params } : {}),
  });

  // wallet-api's HTTP server only responds on POST /api/wallet — anything
  // else returns 404 (see beam/wallet/api/cli/api_cli.cpp::handleRequest).
  // Allow operators to bake the path into WALLET_API_URL too, but default to
  // appending it when their URL has no path.
  const base = config.WALLET_API_URL.replace(/\/+$/, '');
  const url = /\/api\/wallet$/.test(base) ? base : `${base}/api/wallet`;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const { statusCode, body: respBody } = await request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      if (statusCode >= 500) {
        lastErr = new Error(`wallet-api HTTP ${statusCode}`);
      } else {
        const json = (await respBody.json()) as JsonRpcResult<T>;
        if (json.error) {
          // JSON-RPC errors are application-level — surface immediately, don't retry.
          throw new Error(`wallet-api ${method} failed: ${json.error.message} (code ${json.error.code})`);
        }
        return json;
      }
    } catch (err) {
      lastErr = err;
      if (err instanceof Error && err.message.startsWith('wallet-api ')) throw err;
    }
    if (attempt < MAX_ATTEMPTS) {
      const delay = BASE_BACKOFF_MS * 2 ** (attempt - 1);
      logger.warn({ method, attempt, delay }, 'wallet-api request failed; retrying');
      await sleep(delay);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// assets_swap_offers_list
//
// Wire shape from docs-gitbook/core-tech/api/Beam-wallet-protocol-API-v7.4.md
// + beam/wallet/api/v7_2/v7_2_api_defs.h:
//
//   {
//     "id": 1, "jsonrpc": "2.0",
//     "offers": [{
//       "create_time":    1667219066,
//       "expire_time":    1667240666,
//       "id":             "<32-hex>",
//       "isMy":           false,
//       "receiveAmount":  100000000,
//       "receiveAssetId": 0,
//       "receiveCurrencyName": "BEAM",
//       "sendAmount":     100000000,
//       "sendAssetId":    2,
//       "sendCurrencyName": "SHEKELb"
//     }]
//   }
// ---------------------------------------------------------------------------

export interface AssetSwapOffer {
  id: string;
  isMy: boolean;
  sendAssetId: number;
  sendAmount: number;
  sendCurrencyName: string;
  receiveAssetId: number;
  receiveAmount: number;
  receiveCurrencyName: string;
  create_time: number;
  expire_time: number;
}

export async function listAssetSwapOffers(): Promise<AssetSwapOffer[]> {
  const resp = await call<{ offers: AssetSwapOffer[] }>('assets_swap_offers_list');
  // Per wire shape above, offers are at the top level — not under `result`.
  // Be defensive and accept both, since wallet-api implementations have
  // varied here historically.
  const offers = (resp.offers ?? resp.result?.offers ?? []) as AssetSwapOffer[];
  if (!Array.isArray(offers)) {
    throw new Error(`wallet-api assets_swap_offers_list: unexpected shape ${JSON.stringify(resp).slice(0, 200)}`);
  }
  return offers;
}

// ---------------------------------------------------------------------------
// invoke_contract (app-shader execution)
//
// Wallet-side. Runs an app shader against the connected node's contract
// state and returns its JSON output. We use this read-only (`create_tx:
// false`) to query the DApp Store registry — the explorer can't decode
// state behind the `upgradable2` wrapper, but the wallet-bundled
// `dapps_store_app.wasm` can.
//
// Per the v7.4 spec the JSON-RPC result is `{ output: "<string>", txid?,
// raw_data? }`. The contract serialises its response via DocAdd* calls,
// so `output` is itself a JSON-encoded string we parse on this side.
// ---------------------------------------------------------------------------

export interface InvokeContractParams {
  args: string;
  /** Raw wasm bytes. wallet-api also accepts `contract_file` (server-local
   *  path) but we send bytes inline — works whether or not the daemon
   *  shares a filesystem with the indexer, and the dapps_store wasm is only
   *  9.7 KB so the wire cost is negligible. */
  contract?: Uint8Array;
  /** Defaults to false: we never want this call path to author a tx. */
  createTx?: boolean;
}

export interface InvokeContractResult<TOutput = unknown> {
  output: TOutput;
  rawOutput: string;
  txid?: string;
}

export async function invokeContract<TOutput = unknown>(params: InvokeContractParams): Promise<InvokeContractResult<TOutput>> {
  const rpcParams: Record<string, unknown> = {
    args: params.args,
    create_tx: params.createTx ?? false,
  };
  if (params.contract) {
    // wallet-api expects `contract` as an array of byte integers.
    rpcParams.contract = Array.from(params.contract);
  }
  const resp = await call<{ output?: string; txid?: string }>('invoke_contract', rpcParams);
  const rawOutput = resp.result?.output ?? '';
  if (typeof rawOutput !== 'string') {
    throw new Error(`wallet-api invoke_contract: unexpected output shape ${JSON.stringify(resp).slice(0, 200)}`);
  }
  let parsed: TOutput;
  try {
    parsed = (rawOutput.length === 0 ? null : JSON.parse(rawOutput)) as TOutput;
  } catch (err) {
    throw new Error(`wallet-api invoke_contract: output is not valid JSON: ${rawOutput.slice(0, 200)}`);
  }
  // Per docs, app shaders surface errors via the JSON payload, not the RPC
  // envelope. Bubble them up uniformly.
  if (parsed && typeof parsed === 'object') {
    const maybe = parsed as unknown as { error?: unknown };
    if (typeof maybe.error === 'string') {
      throw new Error(`shader error: ${maybe.error}`);
    }
  }
  const txid = resp.result?.txid;
  return txid !== undefined
    ? { output: parsed, rawOutput, txid }
    : { output: parsed, rawOutput };
}
