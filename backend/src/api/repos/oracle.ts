import { q } from '../../db.js';

// ---------------------------------------------------------------------------
// /api/oracle — current state of the Oracle2 price feed, read from the
// oracle_state row the indexer projects out of the app shader.
//
// Quorum is derived here rather than stored: it is a function of the snapshot
// height, and the same row answers "which entries are stale" and "is the
// stored median still valid" the same way.
// ---------------------------------------------------------------------------

export interface OracleProvider {
  index: number;
  pk: string;
  value: string;
  h_updated: number;
  /** Blocks since this entry was written, at `height`. */
  age: number;
  stale: boolean;
}

export interface OracleState {
  cid: string;
  kind: string | null;
  height: number;
  refreshed_at: string;
  h_validity: number;
  min_providers: number;
  /** Stored median, or null when the contract holds none. */
  median: string | null;
  /** Height the stored median is valid through; 0 when there is none. */
  median_h_end: number;
  /** The stored median still covers `height`. */
  median_valid: boolean;
  /** Entries inside the validity window at `height`. */
  valid_providers: number;
  /** `valid_providers >= min_providers`. */
  quorum: boolean;
  providers: OracleProvider[];
}

interface Row {
  cid: string;
  kind: string | null;
  height: string;
  h_validity: number;
  min_providers: number;
  median_value: string | null;
  median_h_end: string;
  providers: Array<{ index: number; pk: string; value: string; h_updated: number }>;
  refreshed_at: Date;
}

export async function loadOracleState(): Promise<OracleState | null> {
  const { rows } = await q<Row>(
    `SELECT cid, kind, height, h_validity, min_providers,
            median_value, median_h_end, providers, refreshed_at
       FROM oracle_state WHERE id = 1`,
  );
  const row = rows[0];
  if (!row) return null;

  const height = Number(row.height);
  const medianHEnd = Number(row.median_h_end);
  const providers: OracleProvider[] = row.providers.map((p) => {
    const age = height - p.h_updated;
    return { ...p, age, stale: age > row.h_validity };
  });
  const validProviders = providers.filter((p) => !p.stale).length;

  return {
    cid: row.cid,
    kind: row.kind,
    height,
    refreshed_at: row.refreshed_at.toISOString(),
    h_validity: row.h_validity,
    min_providers: row.min_providers,
    median: row.median_value,
    median_h_end: medianHEnd,
    median_valid: medianHEnd >= height,
    valid_providers: validProviders,
    quorum: validProviders >= row.min_providers,
    providers,
  };
}
