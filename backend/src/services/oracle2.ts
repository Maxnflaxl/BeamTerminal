import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { q } from '../db.js';
import { logger } from '../logger.js';
import { invokeContract } from '../walletApi.js';
import { getContract } from '../explorer.js';

// ---------------------------------------------------------------------------
// Oracle2 state projection, driven by the vendored `oracle2_app.wasm` running
// inside the local wallet-api daemon.
//
// The explorer decodes the oracle's feed table, but not the stored `Median`
// record — so it cannot say through which height the last written median is
// valid, which is the difference between "the feed lost quorum" and "the
// median is simply old". The app shader reads both.
//
// Provenance of the wasm in backend/resources/README.md (sha256 pinned,
// checked on first use).
// ---------------------------------------------------------------------------

const EXPECTED_WASM_SHA256 = '828f0efedaa38a32b44fa2a77a3fbf22a57d6dc37f10d2ad704d62013a3aa899';

// Shader values are scaled by `get_Norm_n()` = 1e9 (app.cpp).
const NORM_DECIMALS = 9;

function resolveWasmPath(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [
    path.resolve(here, '..', '..', 'resources', 'oracle2_app.wasm'), // dist/src/services → backend/
    path.resolve(here, '..', '..', '..', 'resources', 'oracle2_app.wasm'), // src/services → backend/
  ];
}

let cachedWasm: Uint8Array | null = null;
async function loadWasm(): Promise<Uint8Array> {
  if (cachedWasm) return cachedWasm;
  let lastErr: unknown;
  for (const candidate of resolveWasmPath()) {
    try {
      const bytes = await readFile(candidate);
      const sha = createHash('sha256').update(bytes).digest('hex');
      if (sha !== EXPECTED_WASM_SHA256) {
        throw new Error(`oracle2_app.wasm sha256 mismatch at ${candidate}: got ${sha}, expected ${EXPECTED_WASM_SHA256}`);
      }
      cachedWasm = new Uint8Array(bytes);
      logger.info({ candidate, bytes: bytes.length }, 'oracle2_app.wasm loaded');
      return cachedWasm;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `oracle2_app.wasm not found; tried ${resolveWasmPath().join(', ')}: ${lastErr instanceof Error ? lastErr.message : lastErr}`,
  );
}

// ---------------------------------------------------------------------------
// Shader response shapes (oracle2/app.cpp, manager namespace)
// ---------------------------------------------------------------------------

interface ViewParamsOut {
  params?: {
    hValidity?: number;
    nMinProviders?: number;
    provs?: Array<{ pk?: string; val?: number; hUpd?: number }>;
  };
}

interface ViewMedianOut {
  res?: { val?: number; hEnd?: number };
}

/** Exact decimal for a 1e-9-scaled integer. The scaled values are far below
 *  2^53 (a 1e9 scale on a sub-dollar price), so the integer itself survives
 *  JSON.parse; only the division by 1e9 would invent digits in a double. */
function fromNorm(scaled: number): string {
  const neg = scaled < 0;
  const digits = String(Math.abs(scaled)).padStart(NORM_DECIMALS + 1, '0');
  const cut = digits.length - NORM_DECIMALS;
  return `${neg ? '-' : ''}${digits.slice(0, cut)}.${digits.slice(cut)}`;
}

async function oracleCall<T>(action: string): Promise<T> {
  const contract = await loadWasm();
  const args = `role=manager,action=${action},cid=${config.ORACLE_CID}`;
  const { output } = await invokeContract<T>({ args, contract });
  return output;
}

export interface OracleStateProvider {
  index: number;
  pk: string;
  /** Feed value as a decimal string, e.g. "0.055699999". */
  value: string;
  h_updated: number;
}

export interface OracleStateSync {
  providers: number;
  median_h_end: number;
}

export async function syncOracleState(headHeight: number): Promise<OracleStateSync> {
  const [params, median, contract] = await Promise.all([
    oracleCall<ViewParamsOut>('view_params'),
    oracleCall<ViewMedianOut>('view_median'),
    // Only for the human-readable shader label ("Oracle2 v0"); the app shader
    // has no equivalent, and the version drives nothing on our side.
    getContract({ id: config.ORACLE_CID, state: false, nMaxTxs: 0 }).catch(() => null),
  ]);

  const p = params.params;
  if (!p || typeof p.hValidity !== 'number' || typeof p.nMinProviders !== 'number') {
    throw new Error(`oracle2 view_params: unexpected shape ${JSON.stringify(params).slice(0, 200)}`);
  }

  const providers: OracleStateProvider[] = (p.provs ?? []).map((entry, i) => ({
    index: i,
    pk: typeof entry.pk === 'string' ? entry.pk : '',
    value: fromNorm(typeof entry.val === 'number' ? entry.val : 0),
    h_updated: typeof entry.hUpd === 'number' ? entry.hUpd : 0,
  }));

  const medianHEnd = median.res?.hEnd ?? 0;
  const medianScaled = median.res?.val ?? 0;
  // hEnd 0 means no median has ever been written since the last settings
  // change — the contract only recomputes it when a provider feeds it.
  const medianValue = medianHEnd > 0 && medianScaled > 0 ? fromNorm(medianScaled) : null;

  await q(
    `INSERT INTO oracle_state
       (id, cid, kind, height, h_validity, min_providers, median_value, median_h_end, providers, refreshed_at)
     VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8::jsonb, now())
     ON CONFLICT (id) DO UPDATE SET
       cid = EXCLUDED.cid,
       kind = EXCLUDED.kind,
       height = EXCLUDED.height,
       h_validity = EXCLUDED.h_validity,
       min_providers = EXCLUDED.min_providers,
       median_value = EXCLUDED.median_value,
       median_h_end = EXCLUDED.median_h_end,
       providers = EXCLUDED.providers,
       refreshed_at = now()`,
    [
      config.ORACLE_CID,
      contract?.kind ?? null,
      headHeight,
      p.hValidity,
      p.nMinProviders,
      medianValue,
      medianHEnd,
      JSON.stringify(providers),
    ],
  );

  return { providers: providers.length, median_h_end: medianHEnd };
}
