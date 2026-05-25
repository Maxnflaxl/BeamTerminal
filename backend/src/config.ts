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
