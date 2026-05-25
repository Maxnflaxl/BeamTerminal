import pg from 'pg';
import { config } from './config.js';
import { logger } from './logger.js';

// Tell node-postgres to return NUMERIC and BIGINT as strings (default for BIGINT is string,
// but we re-state it for clarity). Callers convert to BigInt or Number explicitly.
// OIDs are stable across Postgres versions.
const NUMERIC_OID = 1700;
const INT8_OID = 20;
pg.types.setTypeParser(NUMERIC_OID, (v) => v);
pg.types.setTypeParser(INT8_OID, (v) => v);

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => {
  logger.error({ err }, 'pg pool error');
});

type Primitive = string | number | bigint | boolean | Date | Buffer | null;
export type QueryArg = Primitive | ReadonlyArray<Primitive>;

export async function q<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: ReadonlyArray<QueryArg> = [],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params as QueryArg[]);
}

export async function shutdown(): Promise<void> {
  await pool.end();
}
