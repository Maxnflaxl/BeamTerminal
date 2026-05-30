// Display helpers reused across screener pages.

function group(v: number, dec: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

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
  const subStr = String(zeros).split('').map((d) => sub[parseInt(d, 10)]).join('');
  const sig = afterDot.slice(zeros, zeros + 4);
  return `0.0${subStr}${sig}`;
}

export function fmtDate(ts: number): string {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  const now = Date.now();
  const diff = (now - d.getTime()) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 7 * 86400) return `${Math.floor(diff / 86400)}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function fmtDateFull(ts: number): string {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
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

/** On-chain groths → whole units. */
export const fromGroths = (groths: number, decimals: number): number => groths / 10 ** decimals;

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
