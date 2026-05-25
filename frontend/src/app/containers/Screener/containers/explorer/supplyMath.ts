// Mirrors beam/core/block_crypt.cpp Rules::Emission and
// beam/core/treasury.cpp Treasury::CreatePlan (mainnet).

export const EXPLORER_API = 'https://explorer.0xmx.net/api/';

export const HALVING_MARKERS = [
  { height: 525601,  label: 'First halving' },
  { height: 2628001, label: 'Second halving' },
  { height: 4730401, label: 'Third halving' },
];

export const FORK_MARKERS = [
  { height: 321321,  label: 'First hard fork' },
  { height: 777777,  label: 'Second hard fork' },
  { height: 1280000, label: 'Third hard fork' },
  { height: 1820000, label: 'Fourth hard fork' },
  { height: 1920000, label: 'Fifth hard fork' },
];

const DROP0 = 1440 * 365;
const DROP1 = 1440 * 365 * 4;
export const EMIT_BASE = 80;
const TREASURY_BASE = EMIT_BASE / 4;
const MATURITY_STEP = Math.floor((1440 * 365) / 12);
const TREASURY_BURSTS = 12 * 5;

export interface Emission { rate: number; hEnd: number }

export function getEmissionEx(h: number, base: number): Emission {
  const b0 = Math.floor(base);
  if (!b0 || h < 1) return { rate: 0, hEnd: 0 };
  const hp = h - 1;
  if (hp < DROP0) return { rate: b0, hEnd: DROP0 + 1 };
  const n = 1 + Math.floor((hp - DROP0) / DROP1);
  if (n >= 53) return { rate: 0, hEnd: 9007199254740991 };
  const hEnd = DROP0 + n * DROP1 + 1;
  let b = b0;
  if (n >= 2) b += b >> 2;
  // eslint-disable-next-line no-bitwise
  return { rate: b >> n, hEnd };
}

export function getEmissionSumRange(hrMin: number, hrMax: number, base: number): number {
  if (hrMax < hrMin) return 0;
  let res = 0;
  let hPos = hrMin;
  while (true) {
    const { rate, hEnd } = getEmissionEx(hPos, base);
    if (!rate) break;
    if (hrMax < hEnd) { res += rate * (hrMax - hPos + 1); break; }
    res += rate * (hEnd - hPos);
    hPos = hEnd;
  }
  return res;
}

interface TreasuryBurst { height: number; val: number }

function buildTreasuryBurstTable(): TreasuryBurst[] {
  let hrMax = 0;
  const bursts: TreasuryBurst[] = [];
  for (let i = 0; i < TREASURY_BURSTS; i += 1) {
    const hrMin = hrMax + 1;
    hrMax += MATURITY_STEP;
    const val = getEmissionSumRange(hrMin, hrMax, TREASURY_BASE);
    bursts.push({ height: hrMax, val });
  }
  bursts.sort((a, b) => a.height - b.height);
  return bursts;
}

const TREASURY_BURST_TABLE = buildTreasuryBurstTable();

export function treasuryReleasedAtHeight(height: number): number {
  let cum = 0;
  for (const b of TREASURY_BURST_TABLE) {
    if (b.height > height) break;
    cum += b.val;
  }
  return cum;
}

export interface SupplySnapshot { total: number; miner: number; treasury: number }

export function expectedSupplyFast(height: number): SupplySnapshot {
  const h = Math.max(0, Math.floor(height));
  const miner = h < 1 ? 0 : getEmissionSumRange(1, h, EMIT_BASE);
  const treasury = treasuryReleasedAtHeight(h);
  return { total: miner + treasury, miner, treasury };
}

export function blockRewardAtHeight(h: number): number {
  return h < 1 ? 0 : getEmissionEx(h, EMIT_BASE).rate;
}

export function emissionRateChangeHeights(tip: number): Set<number> {
  const heights = new Set<number>();
  let hPos = 1;
  while (hPos <= tip) {
    const { rate, hEnd } = getEmissionEx(hPos, EMIT_BASE);
    if (!rate) break;
    if (hEnd <= tip) heights.add(hEnd);
    hPos = hEnd;
  }
  return heights;
}

export function parseExplorerNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = Number(v.replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function extractStatusMetric(node: unknown, label: string): number | null {
  if (!node) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      if (
        Array.isArray(item) && item.length >= 2
        && (item[0] as { type?: string; value?: unknown })?.type === 'th'
        && (item[0] as { value?: unknown })?.value === label
      ) {
        const raw = (item[1] as { value?: unknown })?.value ?? item[1];
        const parsed = parseExplorerNumber(raw);
        if (parsed !== null) return parsed;
      }
      const nested = extractStatusMetric(item, label);
      if (nested !== null) return nested;
    }
    return null;
  }
  if (typeof node === 'object') {
    for (const key of Object.keys(node as Record<string, unknown>)) {
      const nested = extractStatusMetric((node as Record<string, unknown>)[key], label);
      if (nested !== null) return nested;
    }
  }
  return null;
}

export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

export function fmtAmount(n: number): string {
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 8 });
}

export function fmtDateFromHeight(height: number): string {
  // Beam mainnet launched 2019-01-03, 1 block/minute.
  const genesisMs = Date.UTC(2019, 0, 3, 0, 0, 0);
  const d = new Date(genesisMs + Math.max(0, height) * 60 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
