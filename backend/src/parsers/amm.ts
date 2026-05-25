import type {
  ContractResponse,
  GroupRow,
  Row,
  Table,
  TypedCell,
} from '../explorer.js';

// ---------------------------------------------------------------------------
// Pools table — State.Pools, schema (mainnet-verified):
//   [Aid1, Aid2, Volatility, LP-Token, Amount1, Amount2, Amount-LP-Token, Rate 1:2, Rate 2:2]
// ---------------------------------------------------------------------------

export interface PoolStateRow {
  aid1: number;
  aid2: number;
  /** 0 = Low (0.05%), 1 = Medium (0.30%), 2 = High (1.00%). */
  kind: 0 | 1 | 2;
  aid_ctl: number;
  reserve1: bigint;
  reserve2: bigint;
  ctl_supply: bigint;
  /** aid2 per 1 aid1, as a plain number. `null` when the pool is empty. */
  rate_1_2: number | null;
  /** aid1 per 1 aid2. `null` when the pool is empty. */
  rate_2_1: number | null;
}

const VOLATILITY_KIND: Record<string, 0 | 1 | 2> = {
  Low: 0,
  Medium: 1,
  High: 2,
};

export function parsePoolsTable(resp: ContractResponse): PoolStateRow[] {
  const state = resp.State as Record<string, unknown> | undefined;
  if (!state) return [];
  const tbl = state.Pools as Table | undefined;
  if (!tbl || tbl.type !== 'table') return [];

  const out: PoolStateRow[] = [];
  for (const row of tbl.value.slice(1)) {
    if (!Array.isArray(row)) continue; // groups aren't expected in state tables
    if (row.length < 9) continue;

    const aid1 = pickNumber(row[0]);
    const aid2 = pickNumber(row[1]);
    const volatility = pickString(row[2]);
    const aid_ctl = pickNumber(row[3]);
    const reserve1 = pickBigInt(row[4]);
    const reserve2 = pickBigInt(row[5]);
    const ctl_supply = pickBigInt(row[6]);
    const rate12 = parseRate(row[7]);
    const rate21 = parseRate(row[8]);

    if (
      aid1 === null ||
      aid2 === null ||
      volatility === null ||
      aid_ctl === null ||
      reserve1 === null ||
      reserve2 === null ||
      ctl_supply === null
    ) {
      continue;
    }
    const kind = VOLATILITY_KIND[volatility];
    if (kind === undefined) continue;

    out.push({
      aid1,
      aid2,
      kind,
      aid_ctl,
      reserve1,
      reserve2,
      ctl_supply,
      rate_1_2: rate12,
      rate_2_1: rate21,
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Calls history table — schema (mainnet-verified, 8 cells per row though
// the table's header advertises 7):
//   [Height, Cid, Kind, Method, Arguments, Funds, Emission, Keys]
// ---------------------------------------------------------------------------

export type AmmCallKind =
  | 'Trade'
  | 'Liquidity Add'
  | 'Liquidity Withdraw'
  | 'Pool Create'
  | 'Pool Destroy';

const HANDLED_METHODS: ReadonlySet<string> = new Set<AmmCallKind>([
  'Trade',
  'Liquidity Add',
  'Liquidity Withdraw',
  'Pool Create',
  'Pool Destroy',
]);

export interface AmmCallBase {
  height: number;
  method: AmmCallKind;
  aid1: number;
  aid2: number;
  kind: 0 | 1 | 2;
}

export interface TradeCall extends AmmCallBase {
  method: 'Trade';
  /** Asset the user paid IN (positive sign in Funds). */
  aid_in: number;
  /** Asset the user received OUT (negative sign in Funds). */
  aid_out: number;
  /** Magnitude paid in. Always positive. */
  amount_in: bigint;
  /** Magnitude received out. Always positive. */
  amount_out: bigint;
}

export interface LpCall extends AmmCallBase {
  method: 'Liquidity Add' | 'Liquidity Withdraw';
  /** Magnitude of aid1 added (Deposit) or removed (Withdraw). Always positive. */
  amount1: bigint;
  /** Magnitude of aid2 added/removed. Always positive. */
  amount2: bigint;
  /** Magnitude of LP tokens minted (Deposit) or burned (Withdraw). Always positive. */
  amount_ctl: bigint;
  /** LP token AID, from the Emission cell. */
  aid_ctl: number;
}

export interface PoolLifecycleCall extends AmmCallBase {
  method: 'Pool Create' | 'Pool Destroy';
}

export type AmmCall = TradeCall | LpCall | PoolLifecycleCall;

export function parseCallsHistory(resp: ContractResponse): AmmCall[] {
  const tbl = resp['Calls history'];
  if (!tbl || tbl.type !== 'table') return [];

  const out: AmmCall[] = [];
  for (const entry of tbl.value.slice(1)) {
    const primary = isGroupRow(entry) ? entry.value[0] : (entry as Row);
    if (!primary) continue;
    const call = parseCallRow(primary);
    if (call) out.push(call);
  }
  return out;
}

function isGroupRow(x: unknown): x is GroupRow {
  return (
    typeof x === 'object' &&
    x !== null &&
    (x as { type?: unknown }).type === 'group' &&
    Array.isArray((x as { value?: unknown }).value)
  );
}

function parseCallRow(row: Row): AmmCall | null {
  if (!Array.isArray(row) || row.length < 7) return null;

  // Reject nested invocations: a primary AMM call has Cid="" and Kind="" or "DEX v0".
  const cidCell = row[1];
  if (cidCell && cidCell !== '' && !isEmptyTyped(cidCell)) return null;
  const kindCell = row[2];
  if (typeof kindCell === 'string' && kindCell !== '' && kindCell !== 'DEX v0') return null;

  const height = pickNumber(row[0]);
  const method = pickString(row[3]);
  if (height === null || method === null) return null;
  if (!HANDLED_METHODS.has(method)) return null;

  const args = row[4];
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return null;
  const a = args as Record<string, unknown>;
  const rawAid1 = pickNumber(a.Aid1);
  const rawAid2 = pickNumber(a.Aid2);
  const volatility = typeof a.Volatility === 'string' ? a.Volatility : null;
  if (rawAid1 === null || rawAid2 === null || volatility === null) return null;
  const kind = VOLATILITY_KIND[volatility];
  if (kind === undefined) return null;

  // The DEX stores pools under (aid1, aid2) with aid1 < aid2, but call
  // arguments aren't necessarily well-ordered (mainnet has both orderings).
  // Canonicalize here so downstream pool lookups always succeed.
  const aid1 = Math.min(rawAid1, rawAid2);
  const aid2 = Math.max(rawAid1, rawAid2);

  const base = { height, aid1, aid2, kind } as const;

  switch (method) {
    case 'Pool Create':
    case 'Pool Destroy':
      return { ...base, method } satisfies PoolLifecycleCall;

    case 'Trade': {
      const funds = parseFundsTable(row[5]);
      // Trade Funds: two entries, one + (user paid in), one - (user received out).
      // The + entry's AID = aid_in, magnitude = amount_in.
      // The - entry's AID = aid_out, magnitude = amount_out.
      const paidIn = funds.find((f) => f.amount > 0n);
      const recvOut = funds.find((f) => f.amount < 0n);
      if (!paidIn || !recvOut) return null;
      return {
        ...base,
        method: 'Trade',
        aid_in: paidIn.aid,
        aid_out: recvOut.aid,
        amount_in: paidIn.amount,
        amount_out: -recvOut.amount,
      } satisfies TradeCall;
    }

    case 'Liquidity Add':
    case 'Liquidity Withdraw': {
      const funds = parseFundsTable(row[5]);
      const emission = parseFundsTable(row[6]);
      const f1 = funds.find((f) => f.aid === aid1);
      const f2 = funds.find((f) => f.aid === aid2);
      if (!f1 || !f2 || emission.length === 0) return null;
      const lpRow = emission[0]!;
      return {
        ...base,
        method,
        amount1: abs(f1.amount),
        amount2: abs(f2.amount),
        amount_ctl: abs(lpRow.amount),
        aid_ctl: lpRow.aid,
      } satisfies LpCall;
    }

    default:
      return null;
  }
}

function isEmptyTyped(x: unknown): boolean {
  // {"type":"cid","value":""} or similar — treat as empty
  if (typeof x !== 'object' || x === null) return false;
  const v = (x as { value?: unknown }).value;
  return v === '' || v === undefined;
}

// ---------------------------------------------------------------------------
// Funds / Emission helpers
// ---------------------------------------------------------------------------

interface SignedFund {
  aid: number;
  /** Signed groths: positive = into pool, negative = out of pool. */
  amount: bigint;
}

function parseFundsTable(cell: unknown): SignedFund[] {
  if (!cell || typeof cell !== 'object') return [];
  const tbl = cell as { type?: unknown; value?: unknown };
  if (tbl.type !== 'table' || !Array.isArray(tbl.value)) return [];

  const out: SignedFund[] = [];
  for (const row of tbl.value as ReadonlyArray<unknown>) {
    if (!Array.isArray(row) || row.length < 2) continue;
    const aid = pickNumber(row[0]);
    const amount = pickBigInt(row[1], { signed: true });
    if (aid === null || amount === null) continue;
    out.push({ aid, amount });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cell helpers — duplicated from oracle.ts for clarity; not worth a shared
// module until we have a third parser.
// ---------------------------------------------------------------------------

function pickNumber(cell: unknown): number | null {
  if (typeof cell === 'number' && Number.isFinite(cell)) return cell;
  if (isTypedCell(cell)) {
    const v = cell.value;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function pickString(cell: unknown): string | null {
  if (typeof cell === 'string') return cell;
  if (isTypedCell(cell) && typeof cell.value === 'string') return cell.value;
  return null;
}

function pickBigInt(
  cell: unknown,
  opts: { signed?: boolean } = {},
): bigint | null {
  let raw: string | number | undefined;
  if (typeof cell === 'number') raw = cell;
  else if (typeof cell === 'string') raw = cell;
  else if (isTypedCell(cell)) {
    const v = cell.value;
    if (typeof v === 'number' || typeof v === 'string') raw = v;
  }
  if (raw === undefined) return null;

  let s = typeof raw === 'number' ? String(raw) : raw;
  if (!opts.signed && (s.startsWith('+') || s.startsWith('-'))) {
    // Caller asked for an unsigned value but the cell has a sign — accept it
    // by stripping (we trust the caller's context).
    s = s.replace(/^[+-]/, '');
  }
  try {
    return BigInt(s);
  } catch {
    return null;
  }
}

function isTypedCell(cell: unknown): cell is TypedCell {
  return (
    typeof cell === 'object' &&
    cell !== null &&
    'type' in cell &&
    typeof (cell as { type: unknown }).type === 'string'
  );
}

function abs(n: bigint): bigint {
  return n < 0n ? -n : n;
}

/**
 * Rates come as formatted strings, sometimes with a literal space before "E"
 * in scientific notation, e.g. "9.1558766 E-2" or "10.921947" or "" (empty pool).
 */
function parseRate(cell: unknown): number | null {
  if (typeof cell !== 'string' || cell === '') return null;
  const cleaned = cell.replace(/\s+/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}
