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
  // BANS (Beam Anonymous Name Service) registry contract. Indexed into
  // contract_call_events by the watched-contract scrape. Empty string disables
  // the scrape and makes /api/bans/* return empty.
  BANS_CID: z
    .string()
    .regex(CID_HEX, 'BANS_CID must be 64 lowercase hex chars')
    .or(z.literal(''))
    .optional()
    .default('af4550f1f8a6051ffeffea06e0cb978f8076fdfc2101d2273d4e62c86540bc5e'),
  // Backfill anchor for the BANS scrape (first height to walk from). Mirrors
  // DEX_DEPLOY_HEIGHT. The BANS contract deployed at height 1,890,525 (its Create
  // call); the backfill walks forward from there.
  BANS_DEPLOY_HEIGHT: z.coerce.number().int().positive().default(1_890_525),
  // DAO Vault (fee sink / treasury) and DAO Vote (governance) contracts. Indexed
  // into contract_call_events by the watched-contract scrape. Treasury + Revenue
  // read the vault's Deposit/Withdraw calls (no parser change needed); Governance
  // additionally needs the extended explorer parser to decode DaoVote calls/state.
  // Empty string disables the respective subsystem.
  DAO_VAULT_CID: z
    .string()
    .regex(CID_HEX, 'DAO_VAULT_CID must be 64 lowercase hex chars')
    .or(z.literal(''))
    .optional()
    .default('0066b12078623df132b691001b25d7eb94b207b42c018020c9e58152e21ecd25'),
  DAO_VAULT_DEPLOY_HEIGHT: z.coerce.number().int().positive().default(1_890_514),
  DAO_VOTE_CID: z
    .string()
    .regex(CID_HEX, 'DAO_VOTE_CID must be 64 lowercase hex chars')
    .or(z.literal(''))
    .optional()
    .default('64c8bbbd7c411bd7f9f9a0fd4ca678c581350b5b5ce0b0c055033c7e8f69e555'),
  DAO_VOTE_DEPLOY_HEIGHT: z.coerce.number().int().positive().default(1_833_898),
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
  // Wallet API JSON-RPC base URL. When unset, the DApp Store projection and the
  // IPFS mirror/gateway are disabled (no daemon to ask). Asset swaps no longer
  // need it — they come from the explorer's `/asset_swaps` (BeamMW/beam #2054).
  // For dev: http://localhost:10005 once `docker compose up wallet-api` has
  // booted; for prod: an internal URL.
  WALLET_API_URL: z
    .string()
    .url()
    .optional()
    .transform((u) => (u ? u.replace(/\/+$/, '') : undefined)),
  // How often to poll the explorer's `/asset_swaps` for live DEX offers. Offers
  // are gossiped — there's no benefit to going faster than ~15s.
  ASSET_SWAP_POLL_MS: z.coerce.number().int().positive().default(30_000),
  // Ethereum JSON-RPC for the bridge monitor. The default is keyless and, as of
  // 2026-08, the only free public endpoint that serves eth_getLogs over a
  // useful range (10k blocks/query) — see services/ethRpc.ts. Point it at a
  // keyed provider to widen ETH_LOG_WINDOW.
  ETH_RPC_URL: z.string().url().default('https://eth.drpc.org'),
  // Arbitrum One. Same reasoning as ETH_RPC_URL. Note Arbitrum's block height is
  // ~20x Ethereum's, so windowed log scans are impractical there — the Etherscan
  // path (no block-range cap) is what actually backfills that chain.
  ARB_RPC_URL: z.string().url().default('https://arbitrum.drpc.org'),
  // Optional. Only the Beam->Ethereum settlement scan needs it, because
  // `processRemoteMessage` emits no event and the tx list is the sole source.
  // Without it those messages stay 'unknown' rather than being reported as
  // failed; every other part of the bridge monitor works keyless.
  ETHERSCAN_API_KEY: z.string().min(1).optional(),
  // How many 10k-block log windows the bridge sync may walk per cycle. Bounds
  // the cold backfill (~9.1M blocks per Pipe) so it spreads over several ticks
  // instead of stalling one.
  BRIDGE_LOG_WINDOWS_PER_CYCLE: z.coerce.number().int().positive().default(120),
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
