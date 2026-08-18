import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { styled } from '@linaria/react';
import {
  api,
  type ApiChartPoint,
  type ApiChartSeries,
  type ApiBlackholeBody,
  type ApiBlackholeSeries,
  type ChartRes,
} from '../api/client';
import { SimpleChart } from '../components/SimpleChart';
import { CenteredNote } from '../components/CenteredNote';
import { Overlay, useEscapeClose } from '../components/modalChrome';
import { ConfidentialAssetsChart } from '../components/ConfidentialAssetsChart';
import {
  BlackholeChart,
  buildBlackholeColors,
  buildBlackholeLineStyles,
  LINE_STYLE_DASH,
} from '../components/BlackholeChart';
import { downloadBlob, downloadSvgAsPng } from '../components/chart-compare/download';
import { fmtHashrate } from './explorer/shared';
import { LADDERS, MAX_POINTS, TILE_BUCKETS, type ZoomRes } from '../lib/zoomResolution';

// chartKey → the range-mode fetcher (`?res&from&to`) the zoom hook calls once
// the user has zoomed past the daily-only view. Keys without an entry (or
// whose LADDERS entry is daily-only) never leave the static `filterByTimeframe`
// path — see `canZoom` in ExpandedChart.
const RANGE_FETCHERS: Record<string, (a?: { res?: ZoomRes; from?: number; to?: number }) => Promise<ApiChartSeries>> = {
  price: (a) => api.charts.price(a),
  tvl: (a) => api.charts.tvl(a),
  hashrate: (a) => api.charts.hashrate(a),
  difficulty: (a) => api.charts.difficulty(a),
  blockTime: (a) => api.charts.blockTime(a),
  coinbase: (a) => api.charts.coinbase(a),
  dexVolume: (a) => api.charts.dexVolume(a),
  assets: (a) => api.charts.assets(a),
  transactionsDaily: (a) => api.charts.transactionsDaily(a),
  transactionsTotal: (a) => api.charts.transactionsTotal(a),
  txosTotal: (a) => api.charts.txosTotal(a),
  utxosTotal: (a) => api.charts.utxosTotal(a),
  sizeTotal: (a) => api.charts.sizeTotal(a),
  archiveTotal: (a) => api.charts.archiveTotal(a),
  shieldedIns: (a) => api.charts.shieldedInsDaily(a),
  shieldedInsTotal: (a) => api.charts.shieldedInsTotal(a),
  shieldedOuts: (a) => api.charts.shieldedOutsDaily(a),
  shieldedOutsTotal: (a) => api.charts.shieldedOutsTotal(a),
  contractsTotal: (a) => api.charts.contractsTotal(a),
  feesDaily: (a) => api.charts.feesDaily(a),
  feesTotal: (a) => api.charts.feesTotal(a),
  callsDaily: (a) => api.charts.contractCallsDaily(a),
  callsTotal: (a) => api.charts.contractCallsTotal(a),
};

type Timeframe = '1D' | '1W' | '1M' | '3M' | 'YTD' | 'ALL';
const TIMEFRAMES: ReadonlyArray<Timeframe> = ['1D', '1W', '1M', '3M', 'YTD', 'ALL'];
const TIMEFRAME_DAYS: Record<Timeframe, number | null> = {
  '1D': 1,
  '1W': 7,
  '1M': 30,
  '3M': 90,
  YTD: -1,
  ALL: null,
};
// Which server resolution each window pulls. Sub-daily windows use the bounded
// hourly tier; longer windows use the full-history daily tier.
const TIMEFRAME_RES: Record<Timeframe, ChartRes> = {
  '1D': '1h',
  '1W': '1h',
  '1M': '1h',
  '3M': '1d',
  YTD: '1d',
  ALL: '1d',
};

function filterByTimeframe(series: ReadonlyArray<ApiChartPoint>, tf: Timeframe): ApiChartPoint[] {
  if (series.length === 0) return [];
  const days = TIMEFRAME_DAYS[tf];
  if (days === null) return series.slice();
  let cutoff: number;
  if (tf === 'YTD') {
    const last = series[series.length - 1].ts;
    const year = new Date(last * 1000).getUTCFullYear();
    cutoff = Date.UTC(year, 0, 1) / 1000;
  } else {
    cutoff = series[series.length - 1].ts - (days as number) * 86400;
  }
  return series.filter((p) => p.ts >= cutoff);
}

// ── Range (timeframe) + interval model for the expanded chart ───────────────
// The timeframe buttons pick the WINDOW [from, to]; the interval buttons pick
// the bucket. The expanded chart fetches that window at that bucket and renders
// it statically — no auto-resolution, no viewport restoration.
// Stable empty array so `full.data?.series ?? EMPTY_SERIES` keeps a constant
// reference while loading (avoids a useMemo/effect refire loop on every render).
const EMPTY_SERIES: ApiChartPoint[] = [];

const INTERVAL_ORDER: ZoomRes[] = ['1m', '1h', '1d']; // finest → coarsest
const INTERVAL_SEC: Record<ZoomRes, number> = { '1m': 60, '1h': 3600, '1d': 86_400 };

// Approximate window length of a timeframe, data-independent — lets the toolbar
// size the interval buttons before the series has loaded. ALL → Infinity (so
// only the coarsest bucket qualifies).
function timeframeSpanSec(tf: Timeframe): number {
  const days = TIMEFRAME_DAYS[tf];
  if (days === null) return Number.POSITIVE_INFINITY;
  if (tf === 'YTD') {
    const now = Date.now() / 1000;
    return now - Date.UTC(new Date(now * 1000).getUTCFullYear(), 0, 1) / 1000;
  }
  return days * 86_400;
}

// Intervals offered for a window: in the chart's ladder AND ≤ MAX_POINTS buckets,
// with the coarsest ladder entry always allowed as a fallback.
function validIntervals(spanSec: number, ladder: ZoomRes[]): ZoomRes[] {
  const out = INTERVAL_ORDER.filter((iv) => ladder.includes(iv) && spanSec / INTERVAL_SEC[iv] <= MAX_POINTS);
  const coarsest = ladder[ladder.length - 1];
  if (coarsest && !out.includes(coarsest)) out.push(coarsest);
  return out;
}

// Real [from, to] for a timeframe, anchored on the daily series' ACTUAL bounds
// (never epoch-0 → no 1970 axis).
function rangeBoundsFor(series: ReadonlyArray<ApiChartPoint>, tf: Timeframe): { from: number; to: number } | null {
  if (series.length === 0) return null;
  const first = series[0].ts;
  const to = series[series.length - 1].ts;
  const days = TIMEFRAME_DAYS[tf];
  if (days === null) return { from: first, to };
  if (tf === 'YTD') return { from: Date.UTC(new Date(to * 1000).getUTCFullYear(), 0, 1) / 1000, to };
  return { from: Math.max(first, to - days * 86_400), to };
}

// Tile-align the visible window so mouse-zoom refetches share cache keys and the
// key only changes when you cross a tile boundary (no refetch-per-pixel storm).
// Clamped to the data's real [dataFrom, dataTo] — never epoch-0 (no 1970 axis).
function alignFetchWindow(
  fromSec: number,
  toSec: number,
  res: ZoomRes,
  dataFrom: number,
  dataTo: number,
): { from: number; to: number } {
  const tile = INTERVAL_SEC[res] * TILE_BUCKETS;
  const lo = Math.floor(dataFrom / tile) * tile;
  const hi = Math.ceil(dataTo / tile) * tile;
  const from = Math.max(lo, Math.floor(fromSec / tile) * tile);
  let to = Math.min(hi, Math.ceil(toSec / tile) * tile);
  if (to <= from) to = from + tile;
  return { from: Math.max(0, from), to };
}

// Overlay the fine window series onto the daily full series: keep the daily
// points OUTSIDE [from,to] and use the fine points inside. The chart then always
// has full-range coverage (daily everywhere, fine where you're zoomed) — so
// panning never hits whitespace, zoom-out instantly shows the daily base, and an
// in-flight refetch never blanks the view.
function mergeWindow(
  base: ReadonlyArray<ApiChartPoint>,
  fine: ReadonlyArray<ApiChartPoint>,
  from: number,
  to: number,
): ApiChartPoint[] {
  if (fine.length === 0) return base.slice();
  const out: ApiChartPoint[] = [];
  for (const p of base) if (p.ts < from || p.ts > to) out.push(p);
  for (const p of fine) out.push(p);
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

// Timeframe filter for the multi-series blackhole chart. Anchors on the latest
// ts across every series (they all share the chain-head point) and carries each
// asset's pre-window balance forward to a synthetic point at the cutoff — so the
// (cumulative) lines start at their real level instead of mid-air, and assets
// with no in-window deposit still show their flat balance.
function filterBlackholeByTimeframe(series: ReadonlyArray<ApiBlackholeSeries>, tf: Timeframe): ApiBlackholeSeries[] {
  if (tf === 'ALL' || series.length === 0) return series.map((s) => ({ ...s, points: s.points.slice() }));
  let lastTs = 0;
  for (const s of series) {
    const p = s.points[s.points.length - 1];
    if (p && p.ts > lastTs) lastTs = p.ts;
  }
  if (lastTs === 0) return series.map((s) => ({ ...s, points: s.points.slice() }));
  let cutoff: number;
  if (tf === 'YTD') cutoff = Date.UTC(new Date(lastTs * 1000).getUTCFullYear(), 0, 1) / 1000;
  else cutoff = lastTs - (TIMEFRAME_DAYS[tf] as number) * 86400;
  return series
    .map((s) => {
      const pts = s.points.filter((p) => p.ts >= cutoff);
      const before = s.points.filter((p) => p.ts < cutoff);
      if (before.length > 0 && (pts.length === 0 || pts[0].ts > cutoff)) {
        pts.unshift({ ts: cutoff, value: before[before.length - 1].value });
      }
      return { ...s, points: pts };
    })
    .filter((s) => s.points.length > 0);
}

interface FetchState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

function useOneShot<T>(fetcher: () => Promise<T>, enabled = true): FetchState<T> {
  const [state, setState] = useState<FetchState<T>>({ data: null, loading: enabled, error: null });
  const started = useRef(false);
  useEffect(() => {
    if (!enabled || started.current) return undefined;
    started.current = true;
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    fetcher()
      .then((data) => {
        if (!cancelled) setState({ data, loading: false, error: null });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({ data: null, loading: false, error: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
    // Fetch once, on mount or the first time `enabled` flips true. Fetcher
    // identity intentionally ignored (endpoints are server-cached).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
  return state;
}

// Two-tier chart series: always loads the daily tier; lazily loads the hourly
// tier the first time a sub-daily window is selected. Returns whichever tier
// the current resolution asks for.
// Fetch an ApiChartSeries and REFETCH whenever `key` changes (the expanded
// chart's key = chartKey:timeframe:interval). Unlike useOneShot (fetch-once),
// this re-runs on key change and keeps the prior data visible during the
// refetch so switching interval/timeframe doesn't flash "Loading…".
function useKeyedSeries(
  fetcher: () => Promise<ApiChartSeries>,
  key: string,
  enabled: boolean,
): FetchState<ApiChartSeries> {
  const [state, setState] = useState<FetchState<ApiChartSeries>>({ data: null, loading: enabled, error: null });
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  useEffect(() => {
    if (!enabled) {
      setState({ data: null, loading: false, error: null });
      return undefined;
    }
    let cancelled = false;
    setState((s) => ({ data: s.data, loading: true, error: null }));
    fetcherRef
      .current()
      .then((d) => {
        if (!cancelled) setState({ data: d, loading: false, error: null });
      })
      // Keep the last-good data on a failed refetch (transient network blip on a
      // zoom) so the chart shows stale data instead of blanking to an error.
      .catch((e: unknown) => {
        if (!cancelled)
          setState((s) => ({ data: s.data, loading: false, error: e instanceof Error ? e.message : String(e) }));
      });
    return () => {
      cancelled = true;
    };
    // Refetch only when the key or enabled flag changes; fetcher is read via ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);
  return state;
}

function useTiered(
  dailyFetcher: () => Promise<ApiChartSeries>,
  hourlyFetcher: () => Promise<ApiChartSeries>,
  res: ChartRes,
): FetchState<ApiChartSeries> {
  const daily = useOneShot<ApiChartSeries>(dailyFetcher);
  const hourly = useOneShot<ApiChartSeries>(hourlyFetcher, res === '1h');
  return res === '1h' ? hourly : daily;
}

// Prepend a synthetic 0 one day before the first datum so a cumulative-count
// series visually starts from 0 (the DEX had 0 pools before the first create)
// instead of opening at its first day's running total. No-op on an empty or
// missing series.
function withZeroBaseline(state: FetchState<ApiChartSeries>): FetchState<ApiChartSeries> {
  const s = state.data?.series;
  if (!s || s.length === 0) return state;
  return { ...state, data: { series: [{ ts: s[0].ts - 86_400, value: 0 }, ...s] } };
}

type Category = 'blockchain' | 'lelantus' | 'defi';
const CATEGORIES: ReadonlyArray<{ key: Category; label: string }> = [
  { key: 'blockchain', label: 'Blockchain' },
  { key: 'lelantus', label: 'Lelantus' },
  { key: 'defi', label: 'DeFi' },
];

const Page = styled.div`
  width: 100%;
  max-width: 1200px;
  margin: 0 auto;
  padding: 16px;
`;

const CategoryBar = styled.div`
  display: flex;
  & > * + * {
    margin-left: 6px;
  }
`;

const Toolbar = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  & > * + * {
    margin-left: 12px;
  }
  margin-bottom: 12px;
  flex-wrap: wrap;
`;

const TimeframeGroup = styled.div`
  display: flex;
  & > * + * {
    margin-left: 6px;
  }
`;

const TfButton = styled.button<{ active?: boolean }>`
  background: ${(p) => (p.active ? 'rgba(0, 246, 210, 0.18)' : 'transparent')};
  color: ${(p) => (p.active ? '#00f6d2' : 'rgba(255, 255, 255, 0.6)')};
  border: 1px solid ${(p) => (p.active ? 'rgba(0, 246, 210, 0.5)' : 'rgba(255, 255, 255, 0.12)')};
  border-radius: 6px;
  padding: 4px 10px;
  font-family: var(--font-mono);
  font-size: 12px;
  cursor: pointer;
  transition: background 120ms, color 120ms, border-color 120ms;

  &:hover {
    color: #00f6d2;
    border-color: rgba(0, 246, 210, 0.5);
  }

  &:disabled {
    opacity: 0.3;
    cursor: not-allowed;
    color: rgba(255, 255, 255, 0.4);
    border-color: rgba(255, 255, 255, 0.08);
  }
`;

// Candle-interval selector shown in the expanded modal, visually separated from
// the timeframe group by a trailing divider.
const IntervalGroup = styled.div`
  display: flex;
  align-items: center;
  padding-right: 12px;
  margin-right: 4px;
  border-right: 1px solid rgba(255, 255, 255, 0.12);
  & > * + * {
    margin-left: 6px;
  }
`;

const Grid = styled.div`
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-gap: 16px;

  @media (max-width: 800px) {
    grid-template-columns: 1fr;
  }
`;

const Cell = styled.div`
  background: #042548;
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 8px;
  padding: 8px;
  height: 320px;
  display: flex;
  flex-direction: column;
`;

// Header bar above the plot. Keeps the title and the lin/log + expand controls
// out of the chart's right price-scale gutter, so they never sit on top of the
// y-axis numbers.
const CellHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  & > * + * {
    margin-left: 8px;
  }
  padding: 0 2px 6px;
  margin-bottom: 2px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
`;

const CellTitle = styled.div`
  font-family: var(--font-mono);
  font-size: 12px;
  color: rgba(255, 255, 255, 0.7);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;

const CellActions = styled.div`
  display: flex;
  align-items: center;
  & > * + * {
    margin-left: 6px;
  }
  flex-shrink: 0;
`;

const ChartArea = styled.div`
  flex: 1;
  min-height: 0;
  position: relative;
`;

const ExpandButton = styled.button`
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.25);
  color: rgba(255, 255, 255, 0.6);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 4px;
  cursor: pointer;
  padding: 0;
  transition: color 120ms, border-color 120ms, background 120ms;

  &:hover {
    color: #00f6d2;
    border-color: rgba(0, 246, 210, 0.5);
    background: rgba(0, 246, 210, 0.12);
  }
`;

const ScaleToggle = styled.button<{ active?: boolean }>`
  height: 22px;
  padding: 0 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: ${(p) => (p.active ? 'rgba(0, 246, 210, 0.18)' : 'rgba(0, 0, 0, 0.25)')};
  color: ${(p) => (p.active ? '#00f6d2' : 'rgba(255, 255, 255, 0.6)')};
  border: 1px solid ${(p) => (p.active ? 'rgba(0, 246, 210, 0.5)' : 'rgba(255, 255, 255, 0.12)')};
  border-radius: 4px;
  font-family: var(--font-mono);
  font-size: 11px;
  cursor: pointer;
  transition: color 120ms, border-color 120ms, background 120ms;

  &:hover {
    color: #00f6d2;
    border-color: rgba(0, 246, 210, 0.5);
  }
`;

const ExpandIcon: React.FC = () => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 12 12"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <polyline points="7 1 11 1 11 5" />
    <polyline points="5 11 1 11 1 7" />
    <line x1="11" y1="1" x2="7" y2="5" />
    <line x1="1" y1="11" x2="5" y2="7" />
  </svg>
);

const ModalContent = styled.div`
  background: #042548;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  width: 100%;
  max-width: 1200px;
  height: 100%;
  max-height: 760px;
  display: flex;
  flex-direction: column;
  padding: 16px;
  position: relative;
`;

const ModalToolbar = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  & > * + * {
    margin-left: 12px;
  }
  margin-bottom: 12px;
  padding-right: 36px;
  flex-wrap: wrap;
`;

const ModalActionGroup = styled.div`
  display: flex;
  & > * + * {
    margin-left: 6px;
  }
`;

const ModalBody = styled.div`
  flex: 1;
  min-height: 0;
  background: #042548;
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 8px;
  padding: 8px;
`;

const CloseButton = styled.button`
  position: absolute;
  top: 12px;
  right: 12px;
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  color: rgba(255, 255, 255, 0.7);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 6px;
  cursor: pointer;
  font-size: 16px;
  line-height: 1;

  &:hover {
    color: #00f6d2;
    border-color: rgba(0, 246, 210, 0.5);
  }
`;

function fmtUsd(v: number): string {
  if (!Number.isFinite(v)) return '';
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}k`;
  // One decimal count across the whole sub-dollar range so an axis spanning it
  // doesn't mix label widths.
  if (v !== 0 && Math.abs(v) < 1) return `$${v.toFixed(6)}`;
  return `$${v.toFixed(2)}`;
}

function fmtBlockTime(v: number): string {
  if (!Number.isFinite(v)) return '';
  return `${v.toFixed(1)}s`;
}

function fmtBeam(v: number): string {
  // Input is groths; 1 BEAM = 1e8 groths.
  const beam = v / 1e8;
  if (!Number.isFinite(beam)) return '';
  const abs = Math.abs(beam);
  if (abs >= 1e9) return `${(beam / 1e9).toFixed(2)}B BEAM`;
  if (abs >= 1e6) return `${(beam / 1e6).toFixed(2)}M BEAM`;
  if (abs >= 1e3) return `${(beam / 1e3).toFixed(2)}k BEAM`;
  if (abs >= 1) return `${beam.toFixed(2)} BEAM`;
  return `${beam.toFixed(4)} BEAM`;
}

function fmtDifficulty(v: number): string {
  if (!Number.isFinite(v)) return '';
  const abs = Math.abs(v);
  if (abs >= 1e12) return `${(v / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${(v / 1e9).toFixed(2)}G`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(2)}K`;
  return v.toFixed(0);
}

function fmtInt(v: number): string {
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return v.toFixed(0);
}

function fmtBytes(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let n = v;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  // 0 decimals for raw bytes; 2 for KB+ so GB-scale charts show real variation
  // (1 decimal rounds everything to the same 30.7/30.8/30.9 GB).
  return `${n.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

function fmtVol(v: number): string {
  if (!Number.isFinite(v)) return '';
  return `${v.toFixed(v >= 100 ? 0 : 1)}%`;
}

// Native token units (no currency symbol) for the Black Hole chart axis/tooltip.
// Bounded width (k/M/B/T suffixes) so axis labels never grow long enough to
// resize the (pinned) price-axis gutter.
function fmtNative(v: number): string {
  if (!Number.isFinite(v)) return '';
  const abs = Math.abs(v);
  if (abs >= 1e12) return `${(v / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(2)}k`;
  if (abs >= 1) return v.toFixed(2);
  if (abs > 0) return v.toPrecision(3);
  return '0';
}

function toCsv(series: ReadonlyArray<ApiChartPoint>, title: string): string {
  const lines = [`# ${title}`, 'timestamp_iso,timestamp_unix,value'];
  for (const p of series) {
    lines.push(`${new Date(p.ts * 1000).toISOString()},${p.ts},${p.value}`);
  }
  return `${lines.join('\n')}\n`;
}

const escapeXml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

// `count` evenly-spaced values across [min, max], inclusive of both ends.
function axisTicks(min: number, max: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => min + ((max - min) * i) / (count - 1));
}

function toSvg(
  series: ReadonlyArray<ApiChartPoint>,
  title: string,
  formatter: (v: number) => string,
  scale: number,
  emptyLabel?: string,
): string {
  const W = 720;
  const H = 360;
  const pad = {
    l: 64,
    r: 16,
    t: 32,
    b: 32,
  };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;
  if (series.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><text x="${W / 2}" y="${
      H / 2
    }" text-anchor="middle" fill="#888" font-family="sans-serif">${escapeXml(emptyLabel ?? 'No data')}</text></svg>`;
  }
  const xs = series.map((p) => p.ts);
  const ys = series.map((p) => p.value * scale);
  const xMin = xs[0]!;
  const xMax = xs[xs.length - 1]!;
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const xRange = Math.max(1, xMax - xMin);
  const yRange = Math.max(Number.EPSILON, yMax - yMin);
  const px = (t: number): number => pad.l + ((t - xMin) / xRange) * innerW;
  const py = (v: number): number => pad.t + innerH - ((v - yMin) / yRange) * innerH;
  const grid = 'rgba(255,255,255,0.06)';
  const label = 'rgba(255,255,255,0.6)';

  const yGrid = axisTicks(yMin, yMax, 5).map((v) => {
    const y = py(v).toFixed(1);
    return (
      `<line x1="${pad.l}" y1="${y}" x2="${pad.l + innerW}" y2="${y}" stroke="${grid}"/>` +
      `<text x="${pad.l - 6}" y="${py(v) + 3}" text-anchor="end" fill="${label}">${escapeXml(formatter(v))}</text>`
    );
  });
  const xGrid = axisTicks(xMin, xMax, 5).map((t, i, arr) => {
    const x = px(t);
    const anchor = i === 0 ? 'start' : i === arr.length - 1 ? 'end' : 'middle';
    const day = new Date(t * 1000).toISOString().slice(0, 10);
    return (
      `<line x1="${x.toFixed(1)}" y1="${pad.t}" x2="${x.toFixed(1)}" y2="${pad.t + innerH}" stroke="${grid}"/>` +
      `<text x="${x.toFixed(1)}" y="${pad.t + innerH + 18}" text-anchor="${anchor}" fill="${label}">${day}</text>`
    );
  });
  const path = series
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${px(p.ts).toFixed(1)},${py(p.value * scale).toFixed(1)}`)
    .join(' ');
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="sans-serif" font-size="11">`,
    `<rect width="${W}" height="${H}" fill="#042548"/>`,
    `<text x="${pad.l}" y="20" fill="rgba(255,255,255,0.7)" font-size="13">${escapeXml(title)}</text>`,
    ...yGrid,
    ...xGrid,
    `<rect x="${pad.l}" y="${pad.t}" width="${innerW}" height="${innerH}" fill="none" stroke="rgba(255,255,255,0.1)"/>`,
    `<path d="${path}" fill="none" stroke="#00f6d2" stroke-width="2"/>`,
    '</svg>',
  ].join('');
}

// CSV in long ("tidy") format — one row per (asset, point) so the multi-series
// data round-trips into a spreadsheet/dataframe cleanly.
function csvField(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function blackholeCsv(series: ReadonlyArray<ApiBlackholeSeries>, title: string): string {
  const lines = [`# ${title}`, 'timestamp_iso,timestamp_unix,aid,label,value'];
  for (const s of series) {
    for (const p of s.points) {
      lines.push(`${new Date(p.ts * 1000).toISOString()},${p.ts},${s.aid},${csvField(s.label)},${p.value}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

// Multi-line SVG export. Honours the log toggle (all balances are > 0 so a
// log10 mapping is always valid) and draws a wrapped colour legend below the
// title. Mirrors the colours the on-screen chart assigns.
function blackholeSvg(
  series: ReadonlyArray<ApiBlackholeSeries>,
  title: string,
  formatter: (v: number) => string,
  logScale: boolean,
  emptyLabel?: string,
): string {
  const W = 720;
  const H = 380;
  const pad = {
    l: 64,
    r: 16,
    t: 56,
    b: 32,
  };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;
  const colors = buildBlackholeColors(series);
  const styles = buildBlackholeLineStyles(series);
  const allPts = series.flatMap((s) => s.points);
  if (allPts.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><text x="${W / 2}" y="${
      H / 2
    }" text-anchor="middle" fill="#888" font-family="sans-serif">${escapeXml(emptyLabel ?? 'No data')}</text></svg>`;
  }
  const xMin = Math.min(...allPts.map((p) => p.ts));
  const xMax = Math.max(...allPts.map((p) => p.ts));
  const rawYs = allPts.map((p) => p.value);
  const useLog = logScale && rawYs.every((v) => v > 0);
  const ty = (v: number): number => (useLog ? Math.log10(v) : v);
  const yMin = Math.min(...rawYs.map(ty));
  const yMax = Math.max(...rawYs.map(ty));
  const xRange = Math.max(1, xMax - xMin);
  const yRange = Math.max(Number.EPSILON, yMax - yMin);
  const px = (t: number): number => pad.l + ((t - xMin) / xRange) * innerW;
  const py = (v: number): number => pad.t + innerH - ((ty(v) - yMin) / yRange) * innerH;
  const grid = 'rgba(255,255,255,0.06)';
  const label = 'rgba(255,255,255,0.6)';

  const yGrid = axisTicks(yMin, yMax, 5).map((tv) => {
    const realV = useLog ? 10 ** tv : tv;
    const y = (pad.t + innerH - ((tv - yMin) / yRange) * innerH).toFixed(1);
    return (
      `<line x1="${pad.l}" y1="${y}" x2="${pad.l + innerW}" y2="${y}" stroke="${grid}"/>` +
      `<text x="${pad.l - 6}" y="${Number(y) + 3}" text-anchor="end" fill="${label}">${escapeXml(
        formatter(realV),
      )}</text>`
    );
  });
  const xGrid = axisTicks(xMin, xMax, 5).map((t, i, arr) => {
    const x = px(t);
    const anchor = i === 0 ? 'start' : i === arr.length - 1 ? 'end' : 'middle';
    const day = new Date(t * 1000).toISOString().slice(0, 10);
    return (
      `<line x1="${x.toFixed(1)}" y1="${pad.t}" x2="${x.toFixed(1)}" y2="${pad.t + innerH}" stroke="${grid}"/>` +
      `<text x="${x.toFixed(1)}" y="${pad.t + innerH + 18}" text-anchor="${anchor}" fill="${label}">${day}</text>`
    );
  });
  const paths = series.map((s) => {
    const d = s.points
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${px(p.ts).toFixed(1)},${py(p.value).toFixed(1)}`)
      .join(' ');
    const dash = LINE_STYLE_DASH[styles.get(s.aid) ?? 'solid'];
    const dashAttr = dash ? ` stroke-dasharray="${dash}"` : '';
    return `<path d="${d}" fill="none" stroke="${colors.get(s.aid)}" stroke-width="1.5"${dashAttr}/>`;
  });
  // Wrapped legend just under the title.
  let lx = pad.l;
  let ly = 34;
  const legend: string[] = [];
  for (const s of series) {
    const text = `${s.label} #${s.aid}`;
    const w = 18 + text.length * 6.2;
    if (lx + w > W - pad.r) {
      lx = pad.l;
      ly += 14;
    }
    const dash = LINE_STYLE_DASH[styles.get(s.aid) ?? 'solid'];
    const dashAttr = dash ? ` stroke-dasharray="${dash}"` : '';
    legend.push(
      `<line x1="${lx}" y1="${ly - 3}" x2="${lx + 12}" y2="${ly - 3}" stroke="${colors.get(
        s.aid,
      )}" stroke-width="2"${dashAttr}/><text x="${lx + 16}" y="${ly}" fill="${label}">${escapeXml(text)}</text>`,
    );
    lx += w;
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="sans-serif" font-size="11">`,
    `<rect width="${W}" height="${H}" fill="#042548"/>`,
    `<text x="${pad.l}" y="20" fill="rgba(255,255,255,0.7)" font-size="13">${escapeXml(title)}${
      useLog ? ' (log)' : ''
    }</text>`,
    ...legend,
    ...yGrid,
    ...xGrid,
    `<rect x="${pad.l}" y="${pad.t}" width="${innerW}" height="${innerH}" fill="none" stroke="rgba(255,255,255,0.1)"/>`,
    ...paths,
    '</svg>',
  ].join('');
}

interface ChartCellProps {
  state: FetchState<ApiChartSeries>;
  title: string;
  timeframe: Timeframe;
  scale?: number;
  formatter?: (v: number) => string;
  logScale?: boolean;
  chartKey?: string;
  // Consumed by ExpandedChart (via Omit<ChartCellProps, 'onExpand'>); the grid
  // cell ignores it because markers only render at modal size.
  // eslint-disable-next-line react/no-unused-prop-types
  hideAmml?: boolean;
  /** Message shown when the series has no points (defaults to "No data"). */
  emptyLabel?: string;
  onExpand: () => void;
}

// Inner chart picker — `assets` gets the icon-strip variant when rendered in
// the expanded modal (markers need real estate to be useful), and falls back
// to a plain SimpleChart inside the cramped grid cell. Centralising the
// switch here keeps both call sites in sync without prop-drilling a render
// fn.
const InnerChart: React.FC<{
  chartKey: string | undefined;
  expanded?: boolean;
  series: ReadonlyArray<ApiChartPoint>;
  title: string;
  scale?: number;
  formatter?: (v: number) => string;
  logScale?: boolean;
  hideAmml?: boolean;
  overlaySeries?: ReadonlyArray<ApiChartPoint>;
  overlayLabel?: string;
  // Zoom-adaptive resolution (expanded modal only — grid cells never pass
  // these). `assets` renders through ConfidentialAssetsChart, which doesn't
  // have an interactive mode, so these are no-ops on that branch.
  interactive?: boolean;
  onVisibleRangeChange?: (fromSec: number, toSec: number) => void;
  presetWindow?: { from: number; to: number; nonce: number };
}> = ({
  chartKey,
  expanded,
  series,
  title,
  scale,
  formatter,
  logScale,
  hideAmml,
  overlaySeries,
  overlayLabel,
  interactive,
  onVisibleRangeChange,
  presetWindow,
}) => {
  if (chartKey === 'assets') {
    return (
      <ConfidentialAssetsChart
        series={series}
        title={title}
        scale={scale}
        formatter={formatter}
        logScale={logScale}
        showMarkers={expanded === true}
        hideAmml={hideAmml}
      />
    );
  }
  return (
    <SimpleChart
      series={series}
      title={title}
      scale={scale}
      formatter={formatter}
      logScale={logScale}
      overlaySeries={overlaySeries}
      overlayLabel={overlayLabel}
      interactive={interactive}
      onVisibleRangeChange={onVisibleRangeChange}
      presetWindow={presetWindow}
    />
  );
};

// Only mount a cell's lightweight-charts instance while it's near the viewport.
// Each chart is ~5 retina canvas layers (~2MB backing + a GPU texture copy), so
// mounting all ~20 grid cells at once cost ~130MB of canvas/GPU memory. Gating
// on an IntersectionObserver keeps only the visible rows (+ a preload margin)
// live; scrolled-away cells unmount, and the chart components' existing cleanup
// disposes their canvas + WebGL context. Falls back to always-mounted where
// IntersectionObserver is unavailable (the wallet's older QtWebEngine has it).
function useInView<T extends Element>(rootMargin = '400px'): [React.RefObject<T>, boolean] {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return undefined;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) setInView(e.isIntersecting);
      },
      { rootMargin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [rootMargin]);
  return [ref, inView];
}

// Shared grid-cell chrome (title + lin/log toggle + expand button + plot area).
// Both the single-series ChartCell and the multi-series BlackholeCell wrap their
// chart body in it, so the cell shell lives in exactly one place.
const ChartShell: React.FC<{
  title: string;
  logScale?: boolean;
  onExpand: () => void;
  onToggleLog: () => void;
  children: React.ReactNode;
}> = ({ title, logScale, onExpand, onToggleLog, children }) => {
  const [areaRef, inView] = useInView<HTMLDivElement>();
  return (
    <Cell>
      <CellHeader>
        <CellTitle>{title}</CellTitle>
        <CellActions>
          <ScaleToggle active={logScale} onClick={onToggleLog} title="Toggle linear / logarithmic Y axis">
            {logScale ? 'log' : 'lin'}
          </ScaleToggle>
          <ExpandButton onClick={onExpand} title="Expand chart" aria-label="Expand chart">
            <ExpandIcon />
          </ExpandButton>
        </CellActions>
      </CellHeader>
      <ChartArea ref={areaRef}>{inView ? children : null}</ChartArea>
    </Cell>
  );
};

const ChartCell: React.FC<ChartCellProps & { onToggleLog: () => void }> = ({
  state,
  title,
  timeframe,
  scale,
  formatter,
  logScale,
  chartKey,
  emptyLabel,
  onExpand,
  onToggleLog,
}) => {
  const filtered = useMemo(
    () => (state.data ? filterByTimeframe(state.data.series, timeframe) : null),
    [state.data, timeframe],
  );
  return (
    <ChartShell title={title} logScale={logScale} onExpand={onExpand} onToggleLog={onToggleLog}>
      {filtered && filtered.length > 0 ? (
        <InnerChart
          chartKey={chartKey}
          series={filtered}
          title=""
          scale={scale}
          formatter={formatter}
          logScale={logScale}
        />
      ) : (
        <CenteredNote pad="80px 0" size={13}>
          {state.error ?? (state.loading ? 'Loading…' : emptyLabel ?? 'No data')}
        </CenteredNote>
      )}
    </ChartShell>
  );
};

// Grid cell for the multi-series Black Hole chart — same shell as ChartCell,
// but renders BlackholeChart from the multi-series payload.
const BlackholeCell: React.FC<{
  state: FetchState<ApiBlackholeBody>;
  title: string;
  timeframe: Timeframe;
  logScale: boolean;
  formatter: (v: number) => string;
  onExpand: () => void;
  onToggleLog: () => void;
}> = ({ state, title, timeframe, logScale, formatter, onExpand, onToggleLog }) => {
  const filtered = useMemo(
    () => (state.data ? filterBlackholeByTimeframe(state.data.series, timeframe) : null),
    [state.data, timeframe],
  );
  return (
    <ChartShell title={title} logScale={logScale} onExpand={onExpand} onToggleLog={onToggleLog}>
      {filtered && filtered.length > 0 ? (
        <BlackholeChart series={filtered} logScale={logScale} formatter={formatter} />
      ) : (
        <CenteredNote pad="80px 0" size={13}>
          {state.error ?? (state.loading ? 'Loading…' : 'No data')}
        </CenteredNote>
      )}
    </ChartShell>
  );
};

interface ChartSpec {
  key: string;
  title: string;
  /** Single-series payload — present for every chart except `blackhole`. */
  state?: FetchState<ApiChartSeries>;
  /** Multi-series payload — the `blackhole` chart only. */
  multiState?: FetchState<ApiBlackholeBody>;
  scale?: number;
  formatter: (v: number) => string;
  overlay?: { state: FetchState<ApiChartSeries>; label: string };
  /** Message shown when the series is empty (defaults to "No data"). */
  emptyLabel?: string;
}

export const NetworkCharts: React.FC = () => {
  const [timeframe, setTimeframe] = useState<Timeframe>('ALL');
  const res = TIMEFRAME_RES[timeframe];
  // Interval (candle bucket) for the EXPANDED chart only. 'auto' = finest bucket
  // that fits the current VISIBLE window. Reset to 'auto' whenever the timeframe
  // or which chart is expanded changes (see effect below).
  const [chartInterval, setChartInterval] = useState<ZoomRes | 'auto'>('auto');
  // The expanded chart's current visible span (seconds), reported up so the
  // interval buttons enable/disable against what's on screen — as you mouse-zoom
  // in, finer buckets become available. null = not yet reported (use timeframe).
  const [viewSpan, setViewSpan] = useState<number | null>(null);

  const hashrate = useTiered(
    () => api.charts.hashrate(),
    () => api.charts.hashrate({ res: '1h' }),
    res,
  );
  const difficulty = useTiered(
    () => api.charts.difficulty(),
    () => api.charts.difficulty({ res: '1h' }),
    res,
  );
  const blockTime = useTiered(
    () => api.charts.blockTime(),
    () => api.charts.blockTime({ res: '1h' }),
    res,
  );
  const coinbase = useTiered(
    () => api.charts.coinbase(),
    () => api.charts.coinbase({ res: '1h' }),
    res,
  );
  const tvl = useTiered(
    () => api.charts.tvl(),
    () => api.charts.tvl({ res: '1h' }),
    res,
  );
  const price = useTiered(
    () => api.charts.price(),
    () => api.charts.price({ res: '1h' }),
    res,
  );
  const dexVolume = useTiered(
    () => api.charts.dexVolume(),
    () => api.charts.dexVolume({ res: '1h' }),
    res,
  );
  const beamVol = useOneShot<ApiChartSeries>(() => api.charts.beamVol());
  const dexVol = useOneShot<ApiChartSeries>(() => api.charts.dexVol());
  const poolsCreatedRaw = useOneShot<ApiChartSeries>(() => api.charts.poolsCreated());
  const poolsClosedRaw = useOneShot<ApiChartSeries>(() => api.charts.poolsClosed());
  // Start the cumulative pool-count charts at 0 rather than their first day's total.
  const poolsCreated = useMemo(
    () => withZeroBaseline(poolsCreatedRaw),
    [poolsCreatedRaw.data, poolsCreatedRaw.loading, poolsCreatedRaw.error],
  );
  const poolsClosed = useMemo(
    () => withZeroBaseline(poolsClosedRaw),
    [poolsClosedRaw.data, poolsClosedRaw.loading, poolsClosedRaw.error],
  );

  // DEX volume (total) is an all-time cumulative — it can only come from the
  // daily tier (the hourly tier is a bounded trailing-24h window). Derive its
  // running sum from a dedicated daily fetch, independent of the active tier.
  const dexVolumeDaily = useOneShot<ApiChartSeries>(() => api.charts.dexVolume());
  const dexVolumeCumulative = useMemo<FetchState<ApiChartSeries>>(() => {
    if (!dexVolumeDaily.data) {
      return { data: null, loading: dexVolumeDaily.loading, error: dexVolumeDaily.error };
    }
    let acc = 0;
    const series = dexVolumeDaily.data.series.map((p) => {
      acc += p.value;
      return { ts: p.ts, value: acc };
    });
    return { data: { series }, loading: false, error: null };
  }, [dexVolumeDaily.data, dexVolumeDaily.loading, dexVolumeDaily.error]);

  const assets = useTiered(
    () => api.charts.assets(),
    () => api.charts.assets({ res: '1h' }),
    res,
  );
  const transactionsDaily = useTiered(
    () => api.charts.transactionsDaily(),
    () => api.charts.transactionsDaily({ res: '1h' }),
    res,
  );
  const transactionsTotal = useTiered(
    () => api.charts.transactionsTotal(),
    () => api.charts.transactionsTotal({ res: '1h' }),
    res,
  );
  const txosTotal = useTiered(
    () => api.charts.txosTotal(),
    () => api.charts.txosTotal({ res: '1h' }),
    res,
  );
  const utxosTotal = useTiered(
    () => api.charts.utxosTotal(),
    () => api.charts.utxosTotal({ res: '1h' }),
    res,
  );
  const shieldedInsDaily = useTiered(
    () => api.charts.shieldedInsDaily(),
    () => api.charts.shieldedInsDaily({ res: '1h' }),
    res,
  );
  const shieldedInsTotal = useTiered(
    () => api.charts.shieldedInsTotal(),
    () => api.charts.shieldedInsTotal({ res: '1h' }),
    res,
  );
  const shieldedOutsDaily = useTiered(
    () => api.charts.shieldedOutsDaily(),
    () => api.charts.shieldedOutsDaily({ res: '1h' }),
    res,
  );
  const shieldedOutsTotal = useTiered(
    () => api.charts.shieldedOutsTotal(),
    () => api.charts.shieldedOutsTotal({ res: '1h' }),
    res,
  );
  const contractsTotal = useTiered(
    () => api.charts.contractsTotal(),
    () => api.charts.contractsTotal({ res: '1h' }),
    res,
  );
  const sizeTotal = useTiered(
    () => api.charts.sizeTotal(),
    () => api.charts.sizeTotal({ res: '1h' }),
    res,
  );
  const archiveTotal = useTiered(
    () => api.charts.archiveTotal(),
    () => api.charts.archiveTotal({ res: '1h' }),
    res,
  );
  const feesDaily = useTiered(
    () => api.charts.feesDaily(),
    () => api.charts.feesDaily({ res: '1h' }),
    res,
  );
  const feesTotal = useTiered(
    () => api.charts.feesTotal(),
    () => api.charts.feesTotal({ res: '1h' }),
    res,
  );
  const contractCallsDaily = useTiered(
    () => api.charts.contractCallsDaily(),
    () => api.charts.contractCallsDaily({ res: '1h' }),
    res,
  );
  const contractCallsTotal = useTiered(
    () => api.charts.contractCallsTotal(),
    () => api.charts.contractCallsTotal({ res: '1h' }),
    res,
  );
  const blackhole = useOneShot<ApiBlackholeBody>(() => api.charts.blackhole());

  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  // Interval resets to 'auto' (and the reported visible span clears) when the
  // timeframe changes or a different chart is expanded.
  useEffect(() => {
    setChartInterval('auto');
    setViewSpan(null);
  }, [expandedKey, timeframe]);
  const [searchParams, setSearchParams] = useSearchParams();
  // Deep-link from the global search bar: /explorer/charts?chart=<key> opens
  // that chart's extended (expanded) view. An unknown key is a harmless no-op
  // (the modal only renders when the key matches a chart).
  useEffect(() => {
    const chart = searchParams.get('chart');
    if (chart) setExpandedKey(chart);
  }, [searchParams]);

  // Closing the expanded chart also drops ?chart= from the URL, so the state
  // matches the address bar and re-searching the same chart reopens it.
  const closeExpanded = useCallback(() => {
    setExpandedKey(null);
    if (searchParams.has('chart')) {
      const next = new URLSearchParams(searchParams);
      next.delete('chart');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const [category, setCategory] = useState<Category>('blockchain');
  // The Confidential Assets icon strip opens decluttered — the AMM Liquidity
  // Tokens are hidden until the user toggles them on.
  const [hideAmml, setHideAmml] = useState(true);
  // Black Hole balances span ~8 orders of magnitude (0.01 → ~1e9) across
  // assets, so it opens on a log Y axis; everything else defaults to linear.
  const [logPerKey, setLogPerKey] = useState<Record<string, boolean>>({ blackhole: true });
  const toggleLog = (k: string): void => setLogPerKey((m) => ({ ...m, [k]: !m[k] }));

  // Ordered so each "… / day" chart sits immediately before its "… (total)"
  // twin — the 2-column auto-flow Grid then renders them side-by-side on one
  // row (day on the left, total on the right). Charts without a day/total
  // twin are listed after the pairs so they fall below in each category.
  const allCharts: ReadonlyArray<ChartSpec & { category: Category }> = [
    // Blockchain — day/total pairs
    {
      key: 'transactionsDaily',
      title: 'Transactions / day',
      state: transactionsDaily,
      formatter: fmtInt,
      category: 'blockchain',
      overlay: { state: coinbase, label: 'Coinbase' },
    },
    {
      key: 'transactionsTotal',
      title: 'Transactions (total)',
      state: transactionsTotal,
      formatter: fmtInt,
      category: 'blockchain',
    },
    {
      key: 'feesDaily',
      title: 'Fees / day',
      state: feesDaily,
      formatter: fmtBeam,
      category: 'blockchain',
    },
    {
      key: 'feesTotal',
      title: 'Fees (total)',
      state: feesTotal,
      formatter: fmtBeam,
      category: 'blockchain',
    },
    {
      key: 'callsDaily',
      title: 'Contract calls / day',
      state: contractCallsDaily,
      formatter: fmtInt,
      category: 'blockchain',
    },
    {
      key: 'callsTotal',
      title: 'Contract calls (total)',
      state: contractCallsTotal,
      formatter: fmtInt,
      category: 'blockchain',
    },
    // Blockchain — standalone
    {
      key: 'hashrate',
      title: 'Hashrate (Beamhash III)',
      state: hashrate,
      formatter: fmtHashrate,
      category: 'blockchain',
    },
    {
      key: 'difficulty',
      title: 'Difficulty',
      state: difficulty,
      formatter: fmtDifficulty,
      category: 'blockchain',
    },
    {
      key: 'blockTime',
      title: 'Avg block time',
      state: blockTime,
      formatter: fmtBlockTime,
      category: 'blockchain',
    },
    {
      key: 'txosTotal',
      title: 'TXOs (total)',
      state: txosTotal,
      formatter: fmtInt,
      category: 'blockchain',
    },
    {
      key: 'utxosTotal',
      title: 'UTXOs',
      state: utxosTotal,
      formatter: fmtInt,
      category: 'blockchain',
    },
    {
      key: 'contractsTotal',
      title: 'Contracts active',
      state: contractsTotal,
      formatter: fmtInt,
      category: 'blockchain',
    },
    {
      key: 'sizeTotal',
      title: 'Total blockchain size',
      state: sizeTotal,
      formatter: fmtBytes,
      category: 'blockchain',
    },
    {
      key: 'archiveTotal',
      title: 'Total archive size',
      state: archiveTotal,
      formatter: fmtBytes,
      category: 'blockchain',
    },
    {
      key: 'assets',
      title: 'Confidential Assets',
      state: assets,
      formatter: fmtInt,
      category: 'blockchain',
    },
    // Lelantus — day/total pairs
    {
      key: 'shieldedIns',
      title: 'Shielded inputs / day',
      state: shieldedInsDaily,
      formatter: fmtInt,
      category: 'lelantus',
    },
    {
      key: 'shieldedInsTotal',
      title: 'Shielded inputs (total)',
      state: shieldedInsTotal,
      formatter: fmtInt,
      category: 'lelantus',
    },
    {
      key: 'shieldedOuts',
      title: 'Shielded outputs / day',
      state: shieldedOutsDaily,
      formatter: fmtInt,
      category: 'lelantus',
    },
    {
      key: 'shieldedOutsTotal',
      title: 'Shielded outputs (total)',
      state: shieldedOutsTotal,
      formatter: fmtInt,
      category: 'lelantus',
    },
    // DeFi — day/total pairs
    {
      key: 'dexVolume',
      title: 'DEX volume / day',
      state: dexVolume,
      formatter: fmtUsd,
      category: 'defi',
    },
    {
      key: 'dexVolumeCumulative',
      title: 'DEX volume (total)',
      state: dexVolumeCumulative,
      formatter: fmtUsd,
      category: 'defi',
    },
    // DeFi — standalone
    {
      key: 'price',
      title: 'BEAM/USD (oracle median)',
      state: price,
      formatter: fmtUsd,
      category: 'defi',
    },
    {
      key: 'tvl',
      title: 'DEX TVL',
      state: tvl,
      formatter: fmtUsd,
      category: 'defi',
    },
    {
      key: 'poolsCreated',
      title: 'DEX Pools created (total)',
      state: poolsCreated,
      formatter: fmtInt,
      category: 'defi',
    },
    {
      key: 'poolsClosed',
      title: 'DEX Pools closed (total)',
      state: poolsClosed,
      formatter: fmtInt,
      category: 'defi',
      emptyLabel: 'No pools closed yet',
    },
    {
      key: 'beamVol',
      title: 'BEAM Volatility Index (30d)',
      state: beamVol,
      formatter: fmtVol,
      category: 'defi',
    },
    {
      key: 'dexVol',
      title: 'DEX Volatility Index (30d)',
      state: dexVol,
      formatter: fmtVol,
      category: 'defi',
    },
    {
      key: 'blackhole',
      title: 'Black Hole (assets burned)',
      multiState: blackhole,
      formatter: fmtNative,
      category: 'defi',
    },
  ];

  const charts = allCharts.filter((c) => c.category === category);
  const expanded = expandedKey ? allCharts.find((c) => c.key === expandedKey) ?? null : null;

  const download = (format: 'csv' | 'svg' | 'png'): void => {
    if (!expanded) return;
    const base = `${expanded.key}-${timeframe}`;
    // Multi-series Black Hole export: long-format CSV, multi-line SVG/PNG.
    if (expanded.multiState) {
      if (!expanded.multiState.data) return;
      const filtered = filterBlackholeByTimeframe(expanded.multiState.data.series, timeframe);
      if (format === 'csv') {
        downloadBlob(blackholeCsv(filtered, expanded.title), `${base}.csv`, 'text/csv;charset=utf-8');
        return;
      }
      const svg = blackholeSvg(
        filtered,
        expanded.title,
        expanded.formatter,
        !!logPerKey[expanded.key],
        expanded.emptyLabel,
      );
      if (format === 'svg') downloadBlob(svg, `${base}.svg`, 'image/svg+xml');
      else downloadSvgAsPng(svg, `${base}.png`);
      return;
    }
    if (!expanded.state?.data) return;
    const filtered = filterByTimeframe(expanded.state.data.series, timeframe);
    if (format === 'csv') {
      downloadBlob(toCsv(filtered, expanded.title), `${base}.csv`, 'text/csv;charset=utf-8');
      return;
    }
    const svg = toSvg(filtered, expanded.title, expanded.formatter, expanded.scale ?? 1, expanded.emptyLabel);
    if (format === 'svg') downloadBlob(svg, `${base}.svg`, 'image/svg+xml');
    else downloadSvgAsPng(svg, `${base}.png`);
  };

  useEscapeClose(closeExpanded, expanded !== null);

  return (
    <Page>
      <Toolbar>
        <CategoryBar>
          {CATEGORIES.map((c) => (
            <TfButton key={c.key} active={category === c.key} onClick={() => setCategory(c.key)}>
              {c.label}
            </TfButton>
          ))}
        </CategoryBar>
        <TimeframeGroup>
          {TIMEFRAMES.map((tf) => (
            <TfButton key={tf} active={timeframe === tf} onClick={() => setTimeframe(tf)}>
              {tf}
            </TfButton>
          ))}
        </TimeframeGroup>
      </Toolbar>
      <Grid>
        {charts.map((c) =>
          c.multiState ? (
            <BlackholeCell
              key={c.key}
              state={c.multiState}
              title={c.title}
              timeframe={timeframe}
              logScale={!!logPerKey[c.key]}
              formatter={c.formatter}
              onExpand={() => setExpandedKey(c.key)}
              onToggleLog={() => toggleLog(c.key)}
            />
          ) : (
            <ChartCell
              key={c.key}
              chartKey={c.key}
              state={c.state!}
              title={c.title}
              timeframe={timeframe}
              scale={c.scale}
              formatter={c.formatter}
              logScale={!!logPerKey[c.key]}
              emptyLabel={c.emptyLabel}
              onExpand={() => setExpandedKey(c.key)}
              onToggleLog={() => toggleLog(c.key)}
            />
          ),
        )}
      </Grid>
      {expanded && (
        <Overlay z={100} backdrop="rgba(0, 0, 0, 0.65)" pad="24px" onClick={closeExpanded}>
          <ModalContent onClick={(e) => e.stopPropagation()}>
            <CloseButton onClick={closeExpanded} aria-label="Close">
              ×
            </CloseButton>
            <ModalToolbar>
              <ModalActionGroup>
                <TfButton
                  active={!!logPerKey[expanded.key]}
                  onClick={() => toggleLog(expanded.key)}
                  title="Toggle linear / logarithmic Y axis"
                >
                  {logPerKey[expanded.key] ? 'log' : 'lin'}
                </TfButton>
                <TfButton onClick={() => download('csv')} title="Download visible series as CSV">
                  CSV
                </TfButton>
                <TfButton onClick={() => download('svg')} title="Download chart as SVG">
                  SVG
                </TfButton>
                <TfButton onClick={() => download('png')} title="Download chart as PNG">
                  PNG
                </TfButton>
                {expanded.key === 'assets' && (
                  <TfButton
                    active={!hideAmml}
                    onClick={() => setHideAmml((v) => !v)}
                    title="Show / hide AMM Liquidity Token icons"
                  >
                    {hideAmml ? 'Show AMML' : 'Hide AMML'}
                  </TfButton>
                )}
              </ModalActionGroup>
              {expanded &&
                !expanded.multiState &&
                (LADDERS[expanded.key]?.length ?? 1) > 1 &&
                expanded.key !== 'assets' && (
                  <IntervalGroup title="Candle interval">
                    <TfButton
                      active={chartInterval === 'auto'}
                      onClick={() => setChartInterval('auto')}
                      title="Auto: finest bucket that fits the range"
                    >
                      Auto
                    </TfButton>
                    {INTERVAL_ORDER.map((iv) => {
                      const ok = validIntervals(
                        viewSpan ?? timeframeSpanSec(timeframe),
                        LADDERS[expanded.key]!,
                      ).includes(iv);
                      return (
                        <TfButton
                          key={iv}
                          active={chartInterval === iv}
                          disabled={!ok}
                          onClick={() => ok && setChartInterval(iv)}
                          title={ok ? `${iv} candles` : 'Too many points for this range'}
                        >
                          {iv}
                        </TfButton>
                      );
                    })}
                  </IntervalGroup>
                )}
              <TimeframeGroup>
                {TIMEFRAMES.map((tf) => (
                  <TfButton key={tf} active={timeframe === tf} onClick={() => setTimeframe(tf)}>
                    {tf}
                  </TfButton>
                ))}
              </TimeframeGroup>
            </ModalToolbar>
            <ModalBody>
              {expanded.multiState ? (
                <ExpandedBlackhole
                  state={expanded.multiState}
                  timeframe={timeframe}
                  logScale={!!logPerKey[expanded.key]}
                  formatter={expanded.formatter}
                />
              ) : (
                <ExpandedChart
                  key={expanded.key}
                  chartKey={expanded.key}
                  state={expanded.state!}
                  title={expanded.title}
                  timeframe={timeframe}
                  interval={chartInterval}
                  onViewSpan={setViewSpan}
                  scale={expanded.scale}
                  formatter={expanded.formatter}
                  logScale={!!logPerKey[expanded.key]}
                  hideAmml={hideAmml}
                  emptyLabel={expanded.emptyLabel}
                  overlay={expanded.overlay}
                />
              )}
            </ModalBody>
          </ModalContent>
        </Overlay>
      )}
    </Page>
  );
};

const ExpandedChart: React.FC<
  Omit<ChartCellProps, 'onExpand'> & {
    overlay?: { state: FetchState<ApiChartSeries>; label: string };
    interval: ZoomRes | 'auto';
    onViewSpan: (spanSec: number) => void;
  }
> = ({
  chartKey,
  state,
  title,
  timeframe,
  interval,
  scale,
  formatter,
  logScale,
  hideAmml,
  emptyLabel,
  overlay,
  onViewSpan,
}) => {
  const ladder = (chartKey && LADDERS[chartKey]) || ['1d'];
  const fetcher = chartKey ? RANGE_FETCHERS[chartKey] : undefined;
  // `assets` renders through ConfidentialAssetsChart (no range support here), so
  // it keeps the static filterByTimeframe path despite having a fetcher.
  const rangeable = !!fetcher && ladder.length > 1 && chartKey !== 'assets';

  // Stable daily full-history series: real [from,to] bounds + the ALL/1d view.
  const full = useKeyedSeries(
    () => (fetcher ? fetcher() : Promise.resolve({ series: [] })),
    `${chartKey ?? ''}:full`,
    rangeable,
  );
  const fullSeries = full.data?.series ?? EMPTY_SERIES;
  const dataFrom = fullSeries.length ? fullSeries[0].ts : 0;
  const dataTo = fullSeries.length ? fullSeries[fullSeries.length - 1].ts : 0;

  // Visible window. `null` = follow the timeframe bounds; mouse-zoom sets it.
  const [view, setView] = useState<{ from: number; to: number } | null>(null);
  useEffect(() => {
    setView(null);
  }, [timeframe]);
  const tfBounds = useMemo(() => rangeBoundsFor(fullSeries, timeframe), [fullSeries, timeframe]);
  const effView = view ?? tfBounds;
  const spanSec = effView ? effView.to - effView.from : 0;

  // Report the VISIBLE span up so the toolbar sizes the interval buttons to what
  // is on screen — finer buckets light up as you zoom in.
  const onViewSpanRef = useRef(onViewSpan);
  onViewSpanRef.current = onViewSpan;
  useEffect(() => {
    if (spanSec > 0) onViewSpanRef.current(spanSec);
  }, [spanSec]);

  // Effective interval: user's pick if valid for the visible span, else the
  // finest that fits. In Auto mode it adapts automatically as you zoom.
  const valid = validIntervals(spanSec || Number.POSITIVE_INFINITY, ladder);
  const effInterval: ZoomRes = interval !== 'auto' && valid.includes(interval) ? interval : valid[0] ?? '1d';

  const fetchWin = useMemo(
    () =>
      effView && fullSeries.length ? alignFetchWindow(effView.from, effView.to, effInterval, dataFrom, dataTo) : null,
    [effView, effInterval, dataFrom, dataTo, fullSeries.length],
  );
  // A daily window covering the whole history == the full series already loaded.
  const useFull = !!fetchWin && effInterval === '1d' && fetchWin.from <= dataFrom && fetchWin.to >= dataTo;
  const win = useKeyedSeries(
    () =>
      fetcher && fetchWin
        ? fetcher({ res: effInterval, from: fetchWin.from, to: fetchWin.to })
        : Promise.resolve({ series: [] }),
    `${chartKey ?? ''}:${effInterval}:${fetchWin?.from ?? 0}:${fetchWin?.to ?? 0}`,
    rangeable && !!fetchWin && !useFull,
  );

  // Command the chart to show exactly the timeframe window on open and on each
  // timeframe click (the tile-aligned fetch covers a bit more; we only VIEW the
  // exact window). Mouse-zoom moves the view from there and drives the refetch.
  const presetNonce = useRef(0);
  const [preset, setPreset] = useState<{ from: number; to: number; nonce: number } | undefined>(undefined);
  useEffect(() => {
    if (!rangeable || !tfBounds) return;
    presetNonce.current += 1;
    setPreset({ ...tfBounds, nonce: presetNonce.current });
  }, [rangeable, tfBounds]); // tfBounds ref changes on data load + timeframe change

  // Debounced zoom → view update (drives the finer refetch); tile-aligned keys
  // make the loop converge and self-terminate.
  const zoomTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onVisibleRange = useCallback((from: number, to: number) => {
    if (zoomTimer.current) clearTimeout(zoomTimer.current);
    zoomTimer.current = setTimeout(() => setView({ from, to }), 200);
  }, []);
  useEffect(
    () => () => {
      if (zoomTimer.current) clearTimeout(zoomTimer.current);
    },
    [],
  );

  const filtered = useMemo(
    () => (state.data ? filterByTimeframe(state.data.series, timeframe) : null),
    [state.data, timeframe],
  );
  const filteredOverlay = useMemo(
    () => (overlay?.state.data ? filterByTimeframe(overlay.state.data.series, timeframe) : null),
    [overlay?.state.data, timeframe],
  );

  // Daily-only charts have no finer tier to refetch, but the expanded chart is
  // still freely pannable/zoomable. Drive the same preset from the filtered
  // window so a timeframe click re-centers the view (rangeable charts do this
  // from tfBounds above).
  useEffect(() => {
    if (rangeable || !filtered || filtered.length === 0) return;
    presetNonce.current += 1;
    setPreset({ from: filtered[0].ts, to: filtered[filtered.length - 1].ts, nonce: presetNonce.current });
  }, [rangeable, filtered]);

  let shown: ReadonlyArray<ApiChartPoint> | null;
  let loading: boolean;
  let error: string | null;
  if (rangeable) {
    loading = full.loading || win.loading;
    error = full.error ?? win.error;
    if (!full.data) shown = null; // initial load
    else if (!useFull && win.data && fetchWin)
      shown = mergeWindow(fullSeries, win.data.series, fetchWin.from, fetchWin.to);
    else shown = fullSeries; // daily base: zoomed out, or fine still loading
  } else {
    shown = filtered;
    loading = state.loading;
    error = state.error;
  }

  if (!shown || shown.length === 0)
    return (
      <CenteredNote pad="80px 0" size={13}>
        {error ?? (loading ? 'Loading…' : emptyLabel ?? 'No data')}
      </CenteredNote>
    );
  return (
    <InnerChart
      chartKey={chartKey}
      expanded
      series={shown}
      title={title}
      scale={scale}
      formatter={formatter}
      logScale={logScale}
      hideAmml={hideAmml}
      overlaySeries={filteredOverlay ?? undefined}
      overlayLabel={overlay?.label}
      interactive
      onVisibleRangeChange={rangeable ? onVisibleRange : undefined}
      presetWindow={preset}
    />
  );
};

// Expanded (modal) variant of the multi-series Black Hole chart.
const ExpandedBlackhole: React.FC<{
  state: FetchState<ApiBlackholeBody>;
  timeframe: Timeframe;
  logScale: boolean;
  formatter: (v: number) => string;
}> = ({ state, timeframe, logScale, formatter }) => {
  const filtered = useMemo(
    () => (state.data ? filterBlackholeByTimeframe(state.data.series, timeframe) : null),
    [state.data, timeframe],
  );
  if (!filtered || filtered.length === 0) {
    return (
      <CenteredNote pad="80px 0" size={13}>
        {state.error ?? (state.loading ? 'Loading…' : 'No data')}
      </CenteredNote>
    );
  }
  return <BlackholeChart series={filtered} logScale={logScale} formatter={formatter} showMarkers />;
};

// IndexerStatusBadge lives in the global Footer (components/Footer.tsx) now.

export default NetworkCharts;
