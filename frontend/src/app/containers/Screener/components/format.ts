// Display helpers reused across screener pages.

// One cached Intl.NumberFormat per digit count — toLocaleString with options
// constructs a fresh formatter on every call, which adds up across table cells.
const groupFmts = new Map<number, Intl.NumberFormat>();

function group(v: number, dec: number): string {
  let f = groupFmts.get(dec);
  if (!f) {
    f = new Intl.NumberFormat('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
    groupFmts.set(dec, f);
  }
  return f.format(v);
}

/** Grouped fixed-decimal formatting via the cached formatter above. */
export const fmtGrouped = group;

export function fmt$(v: number | null | undefined, dec = 2): string {
  if (v == null || !Number.isFinite(v)) return '$—';
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(2)}K`;
  if (v >= 1) return `$${group(v, dec)}`;
  if (v >= 0.0001) return `$${group(v, 6)}`;
  if (v > 0) return `$${fmtPriceSub(v)}`;
  return '$0.00';
}

export function fmtNum(v: number | null | undefined, dec = 2): string {
  if (v == null || !Number.isFinite(v)) return '—';
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(2)}K`;
  return group(v, dec);
}

export function fmtPct(v: number | null | undefined): { text: string; cls: 'positive' | 'negative' | 'neutral' } {
  if (v == null || !Number.isFinite(v)) return { text: '—', cls: 'neutral' };
  const cls = v > 0 ? 'positive' : v < 0 ? 'negative' : 'neutral';
  const sign = v > 0 ? '+' : '';
  return { text: `${sign}${v.toFixed(2)}%`, cls };
}

/**
 * Canonical formatter for the signed price-impact percentage used by the
 * swap panel and the chart overlay. Always 2 decimals, explicit + / − sign
 * (matching the chart's Y-axis movement: positive = price went up).
 *
 * For sub-0.005% impacts we widen to 4 decimals so micro-trades on deep
 * pools don't all collapse to `0.00%`.
 */
export function fmtPriceImpact(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  const decimals = abs < 0.005 ? 4 : 2;
  const sign = v > 0 ? '+' : v < 0 ? '−' : '';
  return `${sign}${abs.toFixed(decimals)}%`;
}

export function fmtPrice(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v) || v === 0) return '—';
  if (v >= 1) return group(v, 4);
  if (v >= 0.0001) return group(v, 8);
  return fmtPriceSub(v);
}

// DexScreener-style subscript zeros: 0.00000001745 → 0.0₇1745
export function fmtPriceSub(v: number): string {
  if (!v || v === 0) return '0';
  if (v >= 1) return group(v, 4);
  if (v >= 0.001) return group(v, 6);
  const sub = '₀₁₂₃₄₅₆₇₈₉';
  const s = v.toFixed(20);
  const afterDot = s.slice(2);
  let zeros = 0;
  for (let i = 0; i < afterDot.length; i++) {
    if (afterDot[i] === '0') zeros++;
    else break;
  }
  if (zeros < 2) return v.toFixed(Math.min(zeros + 4, 10));
  const subStr = String(zeros)
    .split('')
    .map((d) => sub[parseInt(d, 10)])
    .join('');
  const sig = afterDot.slice(zeros, zeros + 4);
  return `0.0${subStr}${sig}`;
}

/** Seconds → "Ns / Nm / Nh / Nd" (or "Ny Nmo" style composites when `units`
 *  > 1: y / mo / d / h / m ladder, biggest first, at most `units` non-zero
 *  parts). Months are 30 days and years 365 — display-grade, not calendar. */
export function fmtDuration(seconds: number, units = 1): string {
  const s = Math.max(0, Math.round(seconds));
  if (units <= 1) {
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.round(s / 60)}m`;
    if (s < 86400) return `${Math.round(s / 3600)}h`;
    return `${Math.round(s / 86400)}d`;
  }
  if (s < 60) return `${s}s`;
  const ladder: Array<[number, string]> = [
    [365 * 86400, 'y'],
    [30 * 86400, 'mo'],
    [86400, 'd'],
    [3600, 'h'],
    [60, 'm'],
  ];
  const parts: string[] = [];
  let rem = s;
  for (const [size, suf] of ladder) {
    const n = Math.floor(rem / size);
    if (n > 0) {
      parts.push(`${n}${suf}`);
      rem -= n * size;
    }
  }
  return parts.slice(0, units).join(' ');
}

/** Epoch value → milliseconds. Numbers are unix seconds unless they're already
 *  past the millisecond range (≥ 1e12); strings/Dates go through `Date`. */
function toEpochMs(t: number | string | Date | null | undefined): number {
  if (t == null) return NaN;
  if (typeof t === 'number') return t >= 1e12 ? t : t * 1000;
  return new Date(t).getTime();
}

/** "Nx ago" for a past timestamp (unix seconds, ISO string, ms, or Date).
 *  `units` > 1 yields the composite "2y 3mo ago" form. '—' when unparseable. */
export function fmtRelative(t: number | string | Date | null | undefined, opts: { units?: number } = {}): string {
  const ms = toEpochMs(t);
  if (!Number.isFinite(ms)) return '—';
  return `${fmtDuration((Date.now() - ms) / 1000, opts.units ?? 1)} ago`;
}

/** Trade-feed timestamp (unix seconds): relative within a week, then a short
 *  "Mon D" date. */
export function fmtDate(ts: number): string {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  if (Date.now() - d.getTime() >= 7 * 86400 * 1000) {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  return fmtRelative(ts);
}

/** Local-time YYYY-MM-DD for a unix-seconds timestamp (toISOString would
 *  drift a day for users far from UTC). */
export function fmtDayLocal(ts: number): string {
  const d = new Date(ts * 1000);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export function fmtDateFull(ts: number): string {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())}`;
}

export type CompactTier = 'K' | 'M' | 'B' | 'T';

export interface CompactOptions {
  /** Fraction digits for the suffixed tiers — one count for all, or per tier.
   *  Default 2. */
  decimals?: number | Partial<Record<CompactTier, number>>;
  /** |v| < 1000: a fraction-digit count, or a formatter for full control.
   *  Defaults to the tier count. */
  base?: number | ((v: number) => string);
  /** Strip trailing zeros (and a bare point) from the suffixed tiers. */
  trim?: boolean;
  /** Tier suffixes; default uppercase K / M / B / T. */
  suffixes?: Partial<Record<CompactTier, string>>;
}

const COMPACT_TIERS: ReadonlyArray<[CompactTier, number]> = [
  ['T', 1e12],
  ['B', 1e9],
  ['M', 1e6],
  ['K', 1e3],
];

/** Magnitude-suffixed number: 2_500_000 → "2.50M". Tiers on |v|, so negatives
 *  keep their sign. Non-finite → '—'. Every K/M/B ladder in the screener is a
 *  thin wrapper over this so suffix casing and tier breakpoints stay uniform. */
export function compact(v: number | null | undefined, opts: CompactOptions = {}): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  const tierDec = (t: CompactTier): number =>
    typeof opts.decimals === 'number' ? opts.decimals : opts.decimals?.[t] ?? 2;
  for (const [tier, size] of COMPACT_TIERS) {
    if (abs >= size) {
      let num = (v / size).toFixed(tierDec(tier));
      if (opts.trim && num.includes('.')) num = num.replace(/\.?0+$/, '');
      return `${num}${opts.suffixes?.[tier] ?? tier}`;
    }
  }
  const { base } = opts;
  if (typeof base === 'function') return base(v);
  return v.toFixed(base ?? (typeof opts.decimals === 'number' ? opts.decimals : 2));
}

/** Compact K/M/B with trailing-zero trim — 2 decimals for B/M, 1 for K,
 *  2 for sub-1 values, integers otherwise. */
export function fmtCompact(n: number): string {
  return compact(n, {
    decimals: { K: 1 },
    trim: true,
    base: (v) => v.toFixed(Math.abs(v) > 0 && Math.abs(v) < 1 ? 2 : 0),
  });
}

/** Native token units for chart axes/tooltips (no currency symbol). Decimals
 *  follow magnitude — 4.6M BEAM and 0.014 BTC can share one axis — and the
 *  K/M/B/T suffixes bound label width so the price-axis gutter never resizes. */
export function fmtNativeUnits(v: number): string {
  if (!Number.isFinite(v)) return '';
  return compact(v, {
    base: (x) => {
      const abs = Math.abs(x);
      if (abs >= 1) return x.toFixed(2);
      if (abs > 0) return x.toPrecision(3);
      return '0';
    },
  });
}

/** Initials fallback when an asset has no icon — first 2 chars of symbol. */
export function initials(symbol: string | null): string {
  return (symbol || '??').slice(0, 2).toUpperCase();
}

/** Stable pair URL: "<aid1>_<aid2>_<kind>". Underscore form is deep-link-safe
 *  (no accidental URL escaping when shared) and matches the public scheme. */
export function pairUrlId(aid1: number, aid2: number, kind: number): string {
  return `${aid1}_${aid2}_${kind}`;
}

/** Combined-pair URL: "<aid1>_<aid2>" (no kind) — resolves to the pair across
 *  all fee tiers, with the deepest tier as the price reference. */
export function pairKey(aid1: number, aid2: number): string {
  return `${aid1}_${aid2}`;
}

/** Whole units → on-chain groths (the asset's smallest unit) for `decimals`.
 *  Float-based; fine for swap quotes/display. For tx amounts that must be exact
 *  (and can exceed 2^53 groths), use `toGrothsStr`. */
export const toGroths = (whole: number, decimals: number): number => Math.floor(whole * 10 ** decimals);

/** On-chain groths → whole units. Accepts the API's decimal-string amounts;
 *  null/undefined/empty read as 0. Plain Number math on purpose: the Babel
 *  target rewrites `**` to `Math.pow`, which throws on BigInt, and display
 *  amounts fit within MAX_SAFE_INTEGER before the divide. */
export const fromGroths = (groths: number | string | null | undefined, decimals: number): number =>
  Number(groths || 0) / 10 ** decimals;

/** Exact decimal-string → integer-groths string, with no float math, so a
 *  fund-moving tx amount never loses precision above 2^53 groths. Truncates
 *  past `decimals` fractional digits (the chain has no finer unit). */
export function toGrothsStr(amount: string, decimals: number): string {
  const s = (amount ?? '').trim();
  if (!s || s === '.') return '0';
  const [intPart = '', fracPart = ''] = s.split('.');
  const frac = `${fracPart}${'0'.repeat(decimals)}`.slice(0, decimals);
  const digits = `${intPart}${frac}`.replace(/^0+(?=\d)/, '');
  return digits === '' ? '0' : digits;
}

/** Integer-groths string → exact decimal string (string math, so no float
 *  rounding or scientific notation on tiny amounts), trailing zeros trimmed.
 *  Inverse of `toGrothsStr`. */
export function fromGrothsStr(groths: string, decimals: number): string {
  const s = (groths ?? '').trim();
  const neg = s.startsWith('-');
  const digits = s.replace(/[^0-9]/g, '').padStart(decimals + 1, '0');
  const cut = digits.length - decimals;
  const intPart = digits.slice(0, cut).replace(/^0+(?=\d)/, '');
  const frac = decimals > 0 ? digits.slice(cut).replace(/0+$/, '') : '';
  return `${neg ? '-' : ''}${intPart}${frac ? `.${frac}` : ''}`;
}
