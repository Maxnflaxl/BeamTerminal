import 'dotenv/config';
import { z } from 'zod';

const CID_HEX = /^[0-9a-f]{64}$/;

const Env = z.object({
  DATABASE_URL: z.string().url(),
  EXPLORER_URL: z
    .string()
    .url()
    .transform((u) => u.replace(/\/+$/, '')),
  DEX_CID: z.string().regex(CID_HEX, 'DEX_CID must be 64 lowercase hex chars'),
  // Block height at which DEX_CID was deployed. Used as the backfill anchor
  // when the cursor is empty. Optional — when unset, the indexer falls back
  // to scanning /contracts. Setting it skips a round-trip and survives the
  // explorer dropping the contract from its /contracts listing.
  DEX_DEPLOY_HEIGHT: z.coerce.number().int().positive().optional(),
  ORACLE_CID: z.string().regex(CID_HEX, 'ORACLE_CID must be 64 lowercase hex chars'),
  // Beam Asset Minter — source of the per-asset supply cap (`Limit` in
  // State.Tokens). Optional: if unset, max-supply sync is skipped and assets
  // simply report no cap. Minter-issued assets are still readable as raw
  // /assets rows; only the cap enrichment requires this.
  ASSET_MINTER_CID: z
    .string()
    .regex(CID_HEX, 'ASSET_MINTER_CID must be 64 lowercase hex chars')
    .optional(),
  // DApp Store registry contract. Indexed exactly like DEX_CID (same call-list
  // ingest), but parsed into the dapp_* tables instead. Mainnet default is the
  // value hard-coded in beam-ui/ui/model/settings.cpp::getNetworkDappStoreCID().
  // Set to empty string in env to disable the dapp-store subsystem.
  DAPP_STORE_CID: z
    .string()
    .regex(CID_HEX, 'DAPP_STORE_CID must be 64 lowercase hex chars')
    .optional()
    .default('e2d24b686e8d31a0fe97eade9cd23281e7059b74b5757bdb96c820ef9e2af41c'),
  // "Black Hole" burn contract — a deposit-only shader (Env::FundsLock, no
  // withdraw), so per-asset balances are monotonically increasing. Backs the
  // /charts/blackhole DeFi chart, read live from the explorer (no indexing).
  // Mainnet default is the deployed CID; set to empty string in env to disable
  // the chart on networks where it isn't deployed.
  BLACKHOLE_CID: z
    .string()
    .regex(CID_HEX, 'BLACKHOLE_CID must be 64 lowercase hex chars')
    .or(z.literal(''))
    .optional()
    .default('5ab408982b148210e88f180114f10222a2235eafeede0a3a224fda0e523e17b7'),
  // Wallet API JSON-RPC base URL. When unset, the asset-swap-offers subsystem
  // is disabled (no daemon to ask). For dev: http://localhost:10005 once
  // `docker compose up wallet-api` has booted; for prod: an internal URL.
  WALLET_API_URL: z
    .string()
    .url()
    .optional()
    .transform((u) => (u ? u.replace(/\/+$/, '') : undefined)),
  // How often to poll the wallet-api for `assets_swap_offers_list`. Offers
  // are gossiped — there's no benefit to going faster than ~15s.
  ASSET_SWAP_POLL_MS: z.coerce.number().int().positive().default(30_000),
  CONFIRMATIONS: z.coerce.number().int().nonnegative().default(80),
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  API_PORT: z.coerce.number().int().positive().default(3000),
  API_HOST: z.string().default('127.0.0.1'),
  // Per-IP rate limit for the API (req/min). Set to 0 to disable entirely.
  RATE_LIMIT_PER_MIN: z.coerce.number().int().nonnegative().default(600),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export type Config = z.infer<typeof Env>;

function load(): Config {
  const parsed = Env.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment:\n${issues}`);
  }
  return parsed.data;
}

export const config = load();
