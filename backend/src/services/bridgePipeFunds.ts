import { logger } from '../logger.js';
import { getContract } from '../explorer.js';

// The BEAM/WBEAM Pipes are upgradable2-wrapped, so the explorer decodes their
// calls as `Passthrough` with no arguments — but the Funds column still carries
// a signed aid-0 amount per call. Cumulatively summing it reproduces the Pipe's
// Locked Funds exactly, which is what gives the Beam-custody bridges a TVL
// history without extending Parser.cpp.
//
// Two quirks are load-bearing:
//   - every call is listed twice, so the raw sum at a height is exactly double
//     the real one. Sum first, then halve the per-height total — halving each
//     raw entry before summing loses a groth whenever that entry's own amount
//     is odd. Deduping by value instead of halving collapses genuinely
//     identical adjacent calls (two real transfers of the same amount).
//   - amount cells are rendered by AmountBig::Print (explorer/server.cpp,
//     core/block_crypt.cpp Text::Expand), which only ever emits a
//     thousands-grouped fixed-point string ("60,011,001.00000000"); it never
//     switches to scientific notation. That E-notation quirk belongs to the
//     Rate columns' own formatter and does not apply here. An amount string
//     that doesn't fit that shape is a signal something upstream changed, so
//     it throws rather than being coerced into a silently wrong number.

interface Cell { type?: string; value?: unknown }

const AMOUNT_RE = /^[+-]?\d{1,3}(,\d{3})*(\.\d+)?$|^[+-]?\d+(\.\d+)?$/;

function amountToGroths(raw: string): bigint {
  if (!AMOUNT_RE.test(raw)) {
    throw new Error(`bridgePipeFunds: unparseable amount cell ${JSON.stringify(raw)}`);
  }
  const clean = raw.replace(/,/g, '');
  const neg = clean.startsWith('-');
  const [whole, frac = ''] = clean.replace(/^[+-]/, '').split('.');
  const groths = BigInt(whole + frac.padEnd(8, '0').slice(0, 8));
  return neg ? -groths : groths;
}

function collect(node: unknown, height: number, out: Array<{ height: number; delta: bigint }>): void {
  if (Array.isArray(node)) {
    for (const child of node) collect(child, height, out);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const cell = node as Cell;
  if (cell.type === 'table' && Array.isArray(cell.value)) {
    for (const row of cell.value as unknown[]) {
      if (!Array.isArray(row) || row.length < 2) continue;
      const [a, b] = row as Cell[];
      if (a?.type === 'aid' && a.value === 0 && b?.type === 'amount') {
        out.push({ height, delta: amountToGroths(String(b.value)) });
      }
    }
    return;
  }
  if (cell.type === 'group') collect(cell.value, height, out);
}

export async function pipeFundsDeltas(cid: string): Promise<Array<{ height: number; delta: bigint }>> {
  const contract = await getContract({ id: cid, exp_am: true });
  const table = (contract as unknown as Record<string, unknown>)['Calls history'];
  const rows = (table as { value?: unknown[] } | undefined)?.value ?? [];
  const raw: Array<{ height: number; delta: bigint }> = [];
  for (const row of rows.slice(1)) {
    const group = row as Cell;
    const inner = group?.type === 'group' ? (group.value as unknown[]) : (row as unknown[]);
    const first = Array.isArray(inner) ? (inner[0] as unknown[]) : null;
    const height = Number(Array.isArray(first) ? first[0] : (inner as unknown[])[0]);
    if (!Number.isFinite(height)) continue;
    collect(inner, height, raw);
  }
  // Undo the explorer's duplicate listing: sum by height first, then halve —
  // halving before the sum would truncate any odd-groth raw entry to zero.
  const byHeight = new Map<number, bigint>();
  for (const r of raw) byHeight.set(r.height, (byHeight.get(r.height) ?? 0n) + r.delta);
  return [...byHeight.entries()]
    .map(([height, total]) => {
      // The double-listing is an explorer quirk, not a protocol guarantee — if
      // a future Parser.wasm rollout stops duplicating calls, `total / 2n`
      // would truncate a groth off this height forever and skew a public TVL
      // figure. Fail loudly instead of shipping a silently wrong balance.
      if (total % 2n !== 0n) {
        logger.error(
          { cid, height, total: total.toString() },
          'bridgePipeFunds: odd raw Funds total at height; the explorer double-listing invariant broke',
        );
        throw new Error(
          `bridgePipeFunds: odd raw Funds total (${total.toString()}) at height ${height} for ${cid}`,
        );
      }
      return { height, delta: total / 2n };
    })
    .sort((a, b) => a.height - b.height);
}
