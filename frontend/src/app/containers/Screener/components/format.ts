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
