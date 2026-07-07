import type { ContractResponse, GroupRow, Row, TypedCell } from '../explorer.js';

/** One call-history row, flattened. Nested calls (Oracle Get / DaoVault Deposit
 *  under a primary) are separate entries with `parentOrd` set. */
export interface ContractCall {
  height: number;
  /** 0-based index within (height), in explorer order. */
  ord: number;
  /** NULL for primary calls; the primary's ord for nested calls. */
  parentOrd: number | null;
  /** Contract actually invoked; '' for the watched contract itself. */
  targetCid: string;
  kind: string;
  method: string;
  name: string | null;
  args: Record<string, unknown> | null;
  /** aid -> signed groth string (e.g. { "0": "+359123207870" }); null when absent. */
  funds: Record<string, string> | null;
}

/**
 * Generic sibling of amm.ts::parseCallsHistory — keeps raw args/funds instead
 * of typing to Trade/LP. Handles both flat rows and {type:"group"} wrappers,
 * emitting the primary plus each nested call. Call this on a `state=0` response.
 */
export function parseContractCallHistory(resp: ContractResponse): ContractCall[] {
  const tbl = resp['Calls history'];
  if (!tbl || tbl.type !== 'table') return [];

  const out: ContractCall[] = [];
  const ordByHeight = new Map<number, number>();
  const nextOrd = (h: number): number => {
    const n = ordByHeight.get(h) ?? 0;
    ordByHeight.set(h, n + 1);
    return n;
  };

  for (const entry of tbl.value.slice(1)) {
    const group = isGroupRow(entry);
    const primary = group ? entry.value[0] : (entry as Row);
    if (!Array.isArray(primary) || primary.length < 5) continue;

    const height = pickNumber(primary[0]);
    if (height === null) continue;

    const primaryOrd = nextOrd(height);
    const p = parseRow(primary, height, primaryOrd, null);
    if (p) out.push(p);

    if (group) {
      for (const nested of entry.value.slice(1)) {
        if (!Array.isArray(nested)) continue;
        // Nested rows carry an empty height cell — they inherit the primary's.
        const n = parseRow(nested, height, nextOrd(height), primaryOrd);
        if (n) out.push(n);
      }
    }
  }
  return out;
}

function parseRow(row: Row, height: number, ord: number, parentOrd: number | null): ContractCall | null {
  const method = pickString(row[3]);
  if (method === null || method === '') return null;
  const args = flattenArgs(row[4]);
  return {
    height,
    ord,
    parentOrd,
    targetCid: pickCid(row[1]),
    kind: pickString(row[2]) ?? '',
    method,
    name: args ? pickName(args) : null,
    args,
    funds: parseFunds(row[5]),
  };
}

function isGroupRow(x: unknown): x is GroupRow {
  return (
    typeof x === 'object' && x !== null &&
    (x as { type?: unknown }).type === 'group' &&
    Array.isArray((x as { value?: unknown }).value)
  );
}

function pickNumber(cell: unknown): number | null {
  if (typeof cell === 'number' && Number.isFinite(cell)) return cell;
  if (isTypedCell(cell)) {
    const v = cell.value;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

function pickString(cell: unknown): string | null {
  if (typeof cell === 'string') return cell;
  if (isTypedCell(cell) && typeof cell.value === 'string') return cell.value;
  return null;
}

/** row[1] is "" for a primary call, or {type:"cid",value:"…"} for a nested call. */
function pickCid(cell: unknown): string {
  if (isTypedCell(cell) && cell.type === 'cid' && typeof cell.value === 'string') return cell.value;
  return '';
}

/** Flatten the Arguments object: unwrap typed cells to their value, stringify
 *  nested objects. Returns null when the cell isn't an object (e.g. ""). */
function flattenArgs(cell: unknown): Record<string, unknown> | null {
  if (!cell || typeof cell !== 'object' || Array.isArray(cell)) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cell as Record<string, unknown>)) {
    if (v && typeof v === 'object' && 'value' in (v as object)) out[k] = (v as { value: unknown }).value;
    else if (v && typeof v === 'object') out[k] = JSON.stringify(v);
    else out[k] = v;
  }
  return out;
}

function pickName(args: Record<string, unknown>): string | null {
  const n = args.name ?? args.Name;
  return n === undefined || n === null ? null : String(n);
}

/** Funds/Emission table cell → { aid: signedGrothString }, or null. */
function parseFunds(cell: unknown): Record<string, string> | null {
  if (!cell || typeof cell !== 'object') return null;
  const tbl = cell as { type?: unknown; value?: unknown };
  if (tbl.type !== 'table' || !Array.isArray(tbl.value)) return null;
  const out: Record<string, string> = {};
  for (const r of tbl.value as ReadonlyArray<unknown>) {
    if (!Array.isArray(r) || r.length < 2) continue;
    const aid = pickNumber(r[0]);
    const amt = r[1];
    let val: string | null = null;
    if (typeof amt === 'string') val = amt;
    else if (isTypedCell(amt) && (typeof amt.value === 'string' || typeof amt.value === 'number')) val = String(amt.value);
    if (aid === null || val === null) continue;
    out[String(aid)] = val;
  }
  return Object.keys(out).length ? out : null;
}

function isTypedCell(cell: unknown): cell is TypedCell {
  return typeof cell === 'object' && cell !== null && 'type' in cell &&
    typeof (cell as { type: unknown }).type === 'string';
}
