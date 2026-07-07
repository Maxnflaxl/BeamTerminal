import { q } from '../../db.js';

// Tiny JSONB cache (dao_stats table) for the expensive DAO aggregates. Kept
// out of the repo modules it serves so the refresh service can import the
// compute fns without a circular import.

export async function readDaoStat<T>(key: string): Promise<T | null> {
  const { rows } = await q<{ value: T }>('SELECT value FROM dao_stats WHERE key = $1', [key]);
  return rows[0]?.value ?? null;
}

export async function writeDaoStat(key: string, value: unknown): Promise<void> {
  await q(
    `INSERT INTO dao_stats (key, value, refreshed_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, refreshed_at = now()`,
    [key, JSON.stringify(value)],
  );
}
