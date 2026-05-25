import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, shutdown } from '../src/db.js';
import { logger } from '../src/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, '..', 'migrations');

async function ensureMigrationsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function appliedSet(): Promise<Set<string>> {
  const { rows } = await pool.query<{ name: string }>('SELECT name FROM schema_migrations');
  return new Set(rows.map((r) => r.name));
}

async function pendingFiles(applied: Set<string>): Promise<string[]> {
  const entries = await readdir(MIGRATIONS_DIR);
  return entries
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b))
    .filter((f) => !applied.has(f));
}

async function applyOne(name: string): Promise<void> {
  const path = join(MIGRATIONS_DIR, name);
  const sql = await readFile(path, 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
    await client.query('COMMIT');
    logger.info({ migration: name }, 'applied');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  await ensureMigrationsTable();
  const applied = await appliedSet();
  const pending = await pendingFiles(applied);

  if (pending.length === 0) {
    logger.info('schema up to date');
    return;
  }

  logger.info({ count: pending.length, files: pending }, 'applying migrations');
  for (const file of pending) {
    await applyOne(file);
  }
  logger.info('all migrations applied');
}

main()
  .catch((err) => {
    logger.error({ err: err instanceof Error ? err.message : err }, 'migration failed');
    process.exitCode = 1;
  })
  .finally(() => shutdown());
