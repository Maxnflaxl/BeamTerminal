import type { ContractResponse, Table, TypedCell } from '../explorer.js';

export interface OracleFeed {
  index: number;
  pubkey: string;
  last_value: string;
  last_height: number;
  is_outdated: boolean;
}

export interface OracleSnapshot {
  /** Parsed median price string from `State.Median`. */
  beam_usd: number;
  /** Highest block height at which any *active* feed last updated.
   *  Approximates the on-chain `Median.m_hEnd` (which the parser shader does
   *  not expose directly). 0 if no feeds are active. */
  h_end: number;
  /** Feed-by-feed detail, sorted by index. Useful for /api/health diagnostics. */
  feeds: OracleFeed[];
  /** From `State.Settings."Validity Period"`. Blocks before a feed is "outdated". */
  validity_period: number | null;
  /** From `State.Settings."Min Providers"`. */
  min_providers: number | null;
}

/** A parsed median is unavailable (fewer providers than `Min Providers`). */
export class OracleMedianUnavailable extends Error {
  constructor(message = 'oracle median unavailable') {
    super(message);
    this.name = 'OracleMedianUnavailable';
  }
}

/**
 * Extract a snapshot of the oracle's median price from an explorer contract response.
 *
 * Expected response shape (live mainnet, verified 2026-05-16):
 *   {
 *     kind: "Oracle2 v0",
 *     State: {
 *       Median: "0.021750367",
 *       Feeds: { type: "table", value: [<header>, [idx, {type:"blob"}, "0.0557", {type:"height"}, "outdated"|""], …] },
 *       Settings: { "Min Providers": 3, "Validity Period": 220, Upgradable3: { … } }
 *     }
 *   }
 */
export function extractOracleSnapshot(resp: ContractResponse): OracleSnapshot {
  const state = resp.State;
  if (!state || typeof state !== 'object') {
    throw new Error('oracle response missing State');
  }

  const median = (state as Record<string, unknown>).Median;
  if (typeof median !== 'string' || median.length === 0) {
    throw new OracleMedianUnavailable();
  }
  const beam_usd = Number(median);
  if (!Number.isFinite(beam_usd) || beam_usd <= 0) {
    throw new Error(`oracle median is not a positive number: ${JSON.stringify(median)}`);
  }

  const feedsTbl = (state as Record<string, unknown>).Feeds as Table | undefined;
  const feeds = feedsTbl ? parseFeeds(feedsTbl) : [];
  const activeMax = feeds
    .filter((f) => !f.is_outdated)
    .reduce((m, f) => (f.last_height > m ? f.last_height : m), 0);

  const settings = (state as Record<string, unknown>).Settings;
  const validity_period = readNumberField(settings, 'Validity Period');
  const min_providers = readNumberField(settings, 'Min Providers');

  return {
    beam_usd,
    h_end: activeMax,
    feeds,
    validity_period,
    min_providers,
  };
}

function parseFeeds(tbl: Table): OracleFeed[] {
  // tbl.value[0] is the header row; data rows follow.
  const rows = tbl.value.slice(1);
  const out: OracleFeed[] = [];

  for (const row of rows) {
    if (!Array.isArray(row)) continue; // skip group-wrapped rows (not expected here)
    if (row.length < 5) continue;

    const index = pickNumber(row[0]);
    const pubkey = pickBlob(row[1]);
    const last_value = pickString(row[2]);
    const last_height = pickNumber(row[3]);
    const comment = pickString(row[4]);
    if (index === null || last_height === null) continue;

    out.push({
      index,
      pubkey: pubkey ?? '',
      last_value: last_value ?? '',
      last_height,
      is_outdated: comment === 'outdated',
    });
  }

  out.sort((a, b) => a.index - b.index);
  return out;
}

// ---------------------------------------------------------------------------
// Cell helpers — cells can be a bare primitive or a typed wrapper.
// ---------------------------------------------------------------------------

function pickNumber(cell: unknown): number | null {
  if (typeof cell === 'number') return cell;
  if (isTypedCell(cell) && (cell.type === 'aid' || cell.type === 'height')) {
    return typeof cell.value === 'number' ? cell.value : Number(cell.value);
  }
  return null;
}

function pickString(cell: unknown): string | null {
  if (typeof cell === 'string') return cell;
  if (isTypedCell(cell) && typeof cell.value === 'string') return cell.value;
  return null;
}

function pickBlob(cell: unknown): string | null {
  if (isTypedCell(cell) && cell.type === 'blob') return String(cell.value);
  return null;
}

function isTypedCell(cell: unknown): cell is TypedCell {
  return (
    typeof cell === 'object' &&
    cell !== null &&
    'type' in cell &&
    typeof (cell as { type: unknown }).type === 'string'
  );
}

function readNumberField(obj: unknown, key: string): number | null {
  if (typeof obj !== 'object' || obj === null) return null;
  const v = (obj as Record<string, unknown>)[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
}
