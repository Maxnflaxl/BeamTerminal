// Liquidity-position math, ported from dbadol/BeamLiquidityPosition
// (BeamLiquidityPosition.js: computePrices/computeFees/computePnL/computeHypo
// and the IL/scenarios/simulator chart math).
//
// Difference from the original: that tool assumes every asset has 8 decimals
// and works in raw groths. We have real per-asset decimals, so all amounts are
// converted to human units first — price ratios across assets with different
// decimals then come out correct. The pool-share ratio (LP held / LP supply)
// is decimals-invariant, so it stays a raw-groth ratio.

export type Unit = 1 | 2;

export interface PositionInput {
  /** Initial deposit, groths (decimal strings). */
  amount1: string;
  amount2: string;
  amountCtl: string;
  decimals1: number;
  decimals2: number;
  /** Current pool, groths. */
  reserve1: string;
  reserve2: string;
  ctlSupply: string;
  /** Unix seconds. */
  depositTs: number;
  nowTs: number;
}

export interface Metrics {
  // Initial deposit, human units.
  a1i: number;
  a2i: number;
  // Current pool reserves, human units.
  a1p: number;
  a2p: number;
  /** LP held / total LP supply, in [0, 1]. */
  share: number;
  // Prices (value of 1 unit of the "X in Y" asset).
  p2in1init: number; // aid2 priced in aid1, at deposit
  p1in2init: number;
  p2in1pool: number; // aid2 priced in aid1, now
  p1in2pool: number;
  // Position breakdown, human units.
  aid1Total: number;
  aid2Total: number;
  aid1Principal: number;
  aid2Principal: number;
  aid1Fees: number;
  aid2Fees: number;
  durationMs: number;
}

const toHuman = (groths: string, decimals: number): number =>
  Number(groths) / 10 ** decimals;

export function computeMetrics(p: PositionInput): Metrics {
  const a1i = toHuman(p.amount1, p.decimals1);
  const a2i = toHuman(p.amount2, p.decimals2);
  const a1p = toHuman(p.reserve1, p.decimals1);
  const a2p = toHuman(p.reserve2, p.decimals2);
  // Decimals cancel in the LP-token ratio, so raw groths are fine (and avoid a
  // dependency on the LP token's own decimals).
  const share = Number(p.amountCtl) / Number(p.ctlSupply);

  const p2in1init = a1i / a2i;
  const p1in2init = a2i / a1i;
  const p2in1pool = a1p / a2p;
  const p1in2pool = a2p / a1p;

  const aid1Total = a1p * share;
  const aid2Total = a2p * share;

  // Principal via constant product: with k = a1i·a2i held constant, the amount
  // of each asset at the current price is sqrt(k · price). Fees are whatever
  // the realised position exceeds that no-fee principal by.
  const k = a1i * a2i;
  const aid1Principal = Math.sqrt(k * p2in1pool);
  const aid2Principal = Math.sqrt(k * p1in2pool);

  return {
    a1i,
    a2i,
    a1p,
    a2p,
    share,
    p2in1init,
    p1in2init,
    p2in1pool,
    p1in2pool,
    aid1Total,
    aid2Total,
    aid1Principal,
    aid2Principal,
    aid1Fees: aid1Total - aid1Principal,
    aid2Fees: aid2Total - aid2Principal,
    durationMs: Math.max(0, (p.nowTs - p.depositTs) * 1000),
  };
}

export interface Pnl {
  totalInitial: number;
  totalCurrent: number;
  profit: number;
  roi: number; // ratio (0.1 = +10%)
  apr: number; // ratio
  priceChange: number; // ratio
}

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export function computePnl(m: Metrics, unit: Unit): Pnl {
  // Liquidity pairs are balanced 50/50 by value, so total worth is double either side.
  const totalInitial = unit === 1 ? 2 * m.a1i : 2 * m.a2i;
  const totalCurrent = unit === 1 ? 2 * m.aid1Total : 2 * m.aid2Total;
  const roi = totalCurrent / totalInitial - 1;
  const priceChange =
    unit === 1 ? m.p2in1pool / m.p2in1init - 1 : m.p1in2pool / m.p1in2init - 1;
  return {
    totalInitial,
    totalCurrent,
    profit: totalCurrent - totalInitial,
    roi,
    apr: m.durationMs > 0 ? roi * (YEAR_MS / m.durationMs) : 0,
    priceChange,
  };
}

export interface Hypo {
  current: number;
  hodl: number;
  allA1: number;
  allA2: number;
  hodlDiff: number;
  allA1Diff: number;
  allA2Diff: number;
}

export function computeHypo(m: Metrics, unit: Unit): Hypo {
  let current: number;
  let hodl: number;
  let allA1: number;
  let allA2: number;
  if (unit === 1) {
    current = 2 * m.aid1Total;
    hodl = m.a1i + m.a2i * m.p2in1pool;
    allA1 = 2 * m.a1i;
    allA2 = 2 * m.a2i * m.p2in1pool;
  } else {
    current = 2 * m.aid2Total;
    hodl = m.a1i * m.p1in2pool + m.a2i;
    allA1 = 2 * m.a1i * m.p1in2pool;
    allA2 = 2 * m.a2i;
  }
  return {
    current,
    hodl,
    allA1,
    allA2,
    hodlDiff: current - hodl,
    allA1Diff: current - allA1,
    allA2Diff: current - allA2,
  };
}

// --- Analytics chart data (value-space; components map to pixels) -----------

export interface IlCurveData {
  /** Current price ratio (now / initial) in the active unit. */
  r: number;
  maxRatio: number;
  /** Sampled IL curve: il = 2·√ratio/(1+ratio) − 1. */
  curve: Array<{ ratio: number; il: number }>;
  currentIL: number;
  netResult: number; // position incl. fees vs HODL
  currentValue: number;
  principalValue: number;
  currentPrice: number;
}

const ilAt = (ratio: number): number =>
  ratio <= 0 ? -1 : (2 * Math.sqrt(ratio)) / (1 + ratio) - 1;

export function ilCurveData(m: Metrics, unit: Unit): IlCurveData {
  const r = unit === 1 ? m.p2in1pool / m.p2in1init : m.p1in2pool / m.p1in2init;
  const maxRatio = r > 5 ? 10 : 5;
  const hypo = computeHypo(m, unit);
  const steps = 100;
  const curve = Array.from({ length: steps + 1 }, (_, i) => {
    const ratio = (maxRatio * i) / steps;
    return { ratio, il: ilAt(ratio) };
  });
  return {
    r,
    maxRatio,
    curve,
    currentIL: ilAt(r),
    netResult: hypo.current / hypo.hodl - 1,
    currentValue: unit === 1 ? 2 * m.aid1Total : 2 * m.aid2Total,
    principalValue: unit === 1 ? 2 * m.aid1Principal : 2 * m.aid2Principal,
    currentPrice: unit === 1 ? m.p2in1pool : m.p1in2pool,
  };
}

export interface ScenarioBar {
  label: string;
  value: number;
  kind: 'initial' | 'current' | 'hypo';
}

export interface ScenariosData {
  bars: ScenarioBar[];
  initial: number;
  current: number;
  principal: number;
  fees: number;
}

export function scenariosData(
  m: Metrics,
  unit: Unit,
  name1: string,
  name2: string,
): ScenariosData {
  const hypo = computeHypo(m, unit);
  const initial = unit === 1 ? 2 * m.a1i : 2 * m.a2i;
  const current = hypo.current;
  const principal = unit === 1 ? 2 * m.aid1Principal : 2 * m.aid2Principal;
  const fees = unit === 1 ? 2 * m.aid1Fees : 2 * m.aid2Fees;
  return {
    initial,
    current,
    principal,
    fees,
    bars: [
      { label: 'Initial', value: initial, kind: 'initial' },
      { label: 'Current', value: current, kind: 'current' },
      { label: '1.HODL', value: hypo.hodl, kind: 'hypo' },
      { label: `2.All ${name1}`, value: hypo.allA1, kind: 'hypo' },
      { label: `3.All ${name2}`, value: hypo.allA2, kind: 'hypo' },
    ],
  };
}

export interface SimulatorData {
  ratios: number[];
  labels: string[];
  pointsFuture: Array<{ ratio: number; y: number; principal: number; fees: number }>;
  pointsPrincipal: Array<{ ratio: number; y: number }>;
  yInitial: number; // (initialTotal/currentTotal) - 1
  /** Days to offset the IL at current price + average fees, or null if already profitable. */
  breakevenDays: number | null;
}

const SIM_RATIOS = [0.2, 0.25, 0.33, 0.5, 1, 2, 3, 4, 5];
const SIM_LABELS = ['÷5', '÷4', '÷3', '÷2', 'x1', 'x2', 'x3', 'x4', 'x5'];
const MONTH_DAYS = 30.42;

export function simulatorData(
  m: Metrics,
  unit: Unit,
  durationMonths: number,
  usageMultiplier: number,
): SimulatorData {
  const currentTotal = unit === 1 ? 2 * m.aid1Total : 2 * m.aid2Total;
  const initialTotal = unit === 1 ? 2 * m.a1i : 2 * m.a2i;
  const currentPrincipal = unit === 1 ? 2 * m.aid1Principal : 2 * m.aid2Principal;
  const currentFees = unit === 1 ? 2 * m.aid1Fees : 2 * m.aid2Fees;

  const avgDailyFees =
    m.durationMs > 0 ? currentFees / (m.durationMs / (24 * 60 * 60 * 1000)) : 0;
  const projectedDays = durationMonths * MONTH_DAYS;
  const projectedFees = currentFees + avgDailyFees * projectedDays * usageMultiplier;

  const pointsFuture = SIM_RATIOS.map((ratio) => {
    const fPrincipal = currentPrincipal * Math.sqrt(ratio);
    const fTotal = fPrincipal + projectedFees;
    return { ratio, y: fTotal / currentTotal - 1, principal: fPrincipal, fees: projectedFees };
  });
  const pointsPrincipal = SIM_RATIOS.map((ratio) => ({
    ratio,
    y: (currentPrincipal * Math.sqrt(ratio)) / currentTotal - 1,
  }));

  let breakevenDays: number | null = null;
  if (currentTotal < initialTotal && avgDailyFees > 0) {
    breakevenDays = Math.ceil((initialTotal - currentTotal) / avgDailyFees);
  }

  return {
    ratios: SIM_RATIOS,
    labels: SIM_LABELS,
    pointsFuture,
    pointsPrincipal,
    yInitial: initialTotal / currentTotal - 1,
    breakevenDays,
  };
}

// --- Formatting -------------------------------------------------------------

const amountFmt = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 8,
  useGrouping: true,
});

/** Compact amount (e.g. 1,234.5678). */
export function fmtAmount(v: number): string {
  if (!Number.isFinite(v)) return '–';
  return amountFmt.format(v);
}

/** Signed percent from a ratio (0.1 → "+10.00%"). */
export function fmtPct(ratio: number, digits = 2): string {
  if (!Number.isFinite(ratio)) return '–';
  const pct = ratio * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(digits)}%`;
}

export function fmtDuration(ms: number): string {
  const days = Math.floor(ms / 86400000);
  const hours = Math.floor((ms / 3600000) % 24);
  const minutes = Math.floor((ms / 60000) % 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} ${days > 1 ? 'days' : 'day'}`);
  if (hours > 0) parts.push(`${hours} ${hours > 1 ? 'hours' : 'hour'}`);
  if (minutes > 0) parts.push(`${minutes} ${minutes > 1 ? 'minutes' : 'minute'}`);
  return parts.length ? parts.join(', ') : 'less than a minute';
}

export const assetName = (aid: number, symbol: string | null): string =>
  aid === 0 ? 'BEAM' : symbol || `Asset-${aid}`;
