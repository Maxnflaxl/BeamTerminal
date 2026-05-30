import React, { useEffect, useMemo, useState } from 'react';
import { styled } from '@linaria/react';
import { api, type ApiChartPoint, type ApiChartSeries, type ApiBlackholeBody, type ApiBlackholeSeries } from '../api/client';
import { SimpleChart } from '../components/SimpleChart';
import { ConfidentialAssetsChart } from '../components/ConfidentialAssetsChart';
import { BlackholeChart, buildBlackholeColors } from '../components/BlackholeChart';

type Timeframe = '1W' | '1M' | '3M' | 'YTD' | 'ALL';
const TIMEFRAMES: ReadonlyArray<Timeframe> = ['1W', '1M', '3M', 'YTD', 'ALL'];
const TIMEFRAME_DAYS: Record<Timeframe, number | null> = { '1W': 7, '1M': 30, '3M': 90, YTD: -1, ALL: null };

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

// Timeframe filter for the multi-series blackhole chart. Anchors on the latest
// ts across every series (they all share the chain-head point) and carries each
// asset's pre-window balance forward to a synthetic point at the cutoff — so the
// (cumulative) lines start at their real level instead of mid-air, and assets
// with no in-window deposit still show their flat balance.
function filterBlackholeByTimeframe(
  series: ReadonlyArray<ApiBlackholeSeries>,
  tf: Timeframe,
): ApiBlackholeSeries[] {
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

interface FetchState<T> { data: T | null; loading: boolean; error: string | null }

function useOneShot<T>(fetcher: () => Promise<T>): FetchState<T> {
  const [state, setState] = useState<FetchState<T>>({ data: null, loading: true, error: null });
  useEffect(() => {
    let cancelled = false;
    fetcher()
      .then((data) => { if (!cancelled) setState({ data, loading: false, error: null }); })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({ data: null, loading: false, error: err instanceof Error ? err.message : String(err) });
      });
    return () => { cancelled = true; };
    // Run once on mount; chart endpoints have a 10–30min server cache anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return state;
}

type Category = 'blockchain' | 'lelantus' | 'defi';
const CATEGORIES: ReadonlyArray<{ key: Category; label: string }> = [
  { key: 'blockchain', label: 'Blockchain' },
  { key: 'lelantus',   label: 'Lelantus' },
  { key: 'defi',       label: 'DeFi' },
];

const Page = styled.div`
  width: 100%;
  max-width: 1200px;
  margin: 0 auto;
  padding: 16px;
`;

const CategoryBar = styled.div`
  display: flex;
  & > * + * { margin-left: 6px; }
`;

const Toolbar = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  & > * + * { margin-left: 12px; }
  margin-bottom: 12px;
  flex-wrap: wrap;
`;

const TimeframeGroup = styled.div`
  display: flex;
  & > * + * { margin-left: 6px; }
`;

const TfButton = styled.button<{ active?: boolean }>`
  background: ${(p) => (p.active ? 'rgba(0, 246, 210, 0.18)' : 'transparent')};
  color: ${(p) => (p.active ? '#00f6d2' : 'rgba(255, 255, 255, 0.6)')};
  border: 1px solid ${(p) => (p.active ? 'rgba(0, 246, 210, 0.5)' : 'rgba(255, 255, 255, 0.12)')};
  border-radius: 6px;
  padding: 4px 10px;
  font-family: 'SFProDisplay', monospace;
  font-size: 12px;
  cursor: pointer;
  transition: background 120ms, color 120ms, border-color 120ms;

  &:hover {
    color: #00f6d2;
    border-color: rgba(0, 246, 210, 0.5);
  }
`;

const Grid = styled.div`
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;

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
  & > * + * { margin-left: 8px; }
  padding: 0 2px 6px;
  margin-bottom: 2px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
`;

const CellTitle = styled.div`
  font-family: 'SFProDisplay', monospace;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.7);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;

const CellActions = styled.div`
  display: flex;
  align-items: center;
  & > * + * { margin-left: 6px; }
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
  font-family: 'SFProDisplay', monospace;
  font-size: 11px;
  cursor: pointer;
  transition: color 120ms, border-color 120ms, background 120ms;

  &:hover {
    color: #00f6d2;
    border-color: rgba(0, 246, 210, 0.5);
  }
`;

const ExpandIcon: React.FC = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="7 1 11 1 11 5" />
    <polyline points="5 11 1 11 1 7" />
    <line x1="11" y1="1" x2="7" y2="5" />
    <line x1="1" y1="11" x2="5" y2="7" />
  </svg>
);

const ModalBackdrop = styled.div`
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  background: rgba(0, 0, 0, 0.65);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  padding: 24px;
`;

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
  & > * + * { margin-left: 12px; }
  margin-bottom: 12px;
  padding-right: 36px;
  flex-wrap: wrap;
`;

const ModalActionGroup = styled.div`
  display: flex;
  & > * + * { margin-left: 6px; }
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

const Loading = styled.div`
  color: rgba(255, 255, 255, 0.5);
  text-align: center;
  padding: 80px 0;
  font-size: 13px;
`;

function fmtUsd(v: number): string {
  if (!Number.isFinite(v)) return '';
  if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'k';
  return '$' + v.toFixed(2);
}

function fmtSIUnit(v: number, unit: string): string {
  if (!Number.isFinite(v)) return '';
  const abs = Math.abs(v);
  if (abs >= 1e12) return (v / 1e12).toFixed(2) + ' T' + unit;
  if (abs >= 1e9)  return (v / 1e9).toFixed(2)  + ' G' + unit;
  if (abs >= 1e6)  return (v / 1e6).toFixed(2)  + ' M' + unit;
  if (abs >= 1e3)  return (v / 1e3).toFixed(0)  + ' K' + unit;
  return v.toFixed(0) + ' ' + unit;
}

function fmtHashrate(v: number): string {
  return fmtSIUnit(v, 'Sol/s');
}

function fmtBlockTime(v: number): string {
  if (!Number.isFinite(v)) return '';
  return v.toFixed(1) + 's';
}

function fmtBeam(v: number): string {
  // Input is groths; 1 BEAM = 1e8 groths.
  const beam = v / 1e8;
  if (!Number.isFinite(beam)) return '';
  const abs = Math.abs(beam);
  if (abs >= 1e9) return (beam / 1e9).toFixed(2) + 'B BEAM';
  if (abs >= 1e6) return (beam / 1e6).toFixed(2) + 'M BEAM';
  if (abs >= 1e3) return (beam / 1e3).toFixed(2) + 'k BEAM';
  if (abs >= 1)   return beam.toFixed(2)         + ' BEAM';
  return beam.toFixed(4) + ' BEAM';
}

function fmtDifficulty(v: number): string {
  if (!Number.isFinite(v)) return '';
  const abs = Math.abs(v);
  if (abs >= 1e12) return (v / 1e12).toFixed(2) + 'T';
  if (abs >= 1e9)  return (v / 1e9).toFixed(2)  + 'G';
  if (abs >= 1e6)  return (v / 1e6).toFixed(2)  + 'M';
  if (abs >= 1e3)  return (v / 1e3).toFixed(2)  + 'K';
  return v.toFixed(0);
}

function fmtInt(v: number): string {
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k';
  return v.toFixed(0);
}

function fmtVol(v: number): string {
  if (!Number.isFinite(v)) return '';
  return v.toFixed(v >= 100 ? 0 : 1) + '%';
}

// Native token units (no currency symbol) for the Black Hole chart axis/tooltip.
function fmtNative(v: number): string {
  if (!Number.isFinite(v)) return '';
  const abs = Math.abs(v);
  if (abs >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return (v / 1e3).toFixed(2) + 'k';
  if (abs >= 1) return v.toFixed(2);
  if (abs > 0) return v.toPrecision(3);
  return '0';
}

function toCsv(series: ReadonlyArray<ApiChartPoint>, title: string): string {
  const lines = [`# ${title}`, 'timestamp_iso,timestamp_unix,value'];
  for (const p of series) {
    lines.push(`${new Date(p.ts * 1000).toISOString()},${p.ts},${p.value}`);
  }
  return lines.join('\n') + '\n';
}

function triggerDownload(url: string, filename: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function downloadBlob(content: BlobPart, filename: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  triggerDownload(url, filename);
  URL.revokeObjectURL(url);
}

// Rasterise an SVG string to a PNG at `scale`× the intrinsic size, then save it.
function downloadSvgAsPng(svg: string, filename: string, scale = 2): void {
  const svgUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = img.width * scale;
    canvas.height = img.height * scale;
    const ctx = canvas.getContext('2d');
    URL.revokeObjectURL(svgUrl);
    if (!ctx) return;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((b) => {
      if (!b) return;
      const url = URL.createObjectURL(b);
      triggerDownload(url, filename);
      URL.revokeObjectURL(url);
    }, 'image/png');
  };
  img.src = svgUrl;
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
): string {
  const W = 720;
  const H = 360;
  const pad = { l: 64, r: 16, t: 32, b: 32 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;
  if (series.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="#888" font-family="sans-serif">No data</text></svg>`;
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
    `</svg>`,
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
  return lines.join('\n') + '\n';
}

// Multi-line SVG export. Honours the log toggle (all balances are > 0 so a
// log10 mapping is always valid) and draws a wrapped colour legend below the
// title. Mirrors the colours the on-screen chart assigns.
function blackholeSvg(
  series: ReadonlyArray<ApiBlackholeSeries>,
  title: string,
  formatter: (v: number) => string,
  logScale: boolean,
): string {
  const W = 720;
  const H = 380;
  const pad = { l: 64, r: 16, t: 56, b: 32 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;
  const colors = buildBlackholeColors(series);
  const allPts = series.flatMap((s) => s.points);
  if (allPts.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="#888" font-family="sans-serif">No data</text></svg>`;
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
      `<text x="${pad.l - 6}" y="${Number(y) + 3}" text-anchor="end" fill="${label}">${escapeXml(formatter(realV))}</text>`
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
    return `<path d="${d}" fill="none" stroke="${colors.get(s.aid)}" stroke-width="1.5"/>`;
  });
  // Wrapped legend just under the title.
  let lx = pad.l;
  let ly = 34;
  const legend: string[] = [];
  for (const s of series) {
    const text = `${s.label} #${s.aid}`;
    const w = 18 + text.length * 6.2;
    if (lx + w > W - pad.r) { lx = pad.l; ly += 14; }
    legend.push(
      `<line x1="${lx}" y1="${ly - 3}" x2="${lx + 12}" y2="${ly - 3}" stroke="${colors.get(s.aid)}" stroke-width="2"/>` +
      `<text x="${lx + 16}" y="${ly}" fill="${label}">${escapeXml(text)}</text>`,
    );
    lx += w;
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="sans-serif" font-size="11">`,
    `<rect width="${W}" height="${H}" fill="#042548"/>`,
    `<text x="${pad.l}" y="20" fill="rgba(255,255,255,0.7)" font-size="13">${escapeXml(title)}${useLog ? ' (log)' : ''}</text>`,
    ...legend,
    ...yGrid,
    ...xGrid,
    `<rect x="${pad.l}" y="${pad.t}" width="${innerW}" height="${innerH}" fill="none" stroke="rgba(255,255,255,0.1)"/>`,
    ...paths,
    `</svg>`,
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
  hideAmml?: boolean;
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
}> = ({ chartKey, expanded, series, title, scale, formatter, logScale, hideAmml, overlaySeries, overlayLabel }) => {
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
    />
  );
};

const ChartCell: React.FC<ChartCellProps & { onToggleLog: () => void }> = (
  { state, title, timeframe, scale, formatter, logScale, chartKey, onExpand, onToggleLog },
) => {
  const filtered = useMemo(
    () => (state.data ? filterByTimeframe(state.data.series, timeframe) : null),
    [state.data, timeframe],
  );
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
      <ChartArea>
        {filtered ? (
          <InnerChart chartKey={chartKey} series={filtered} title="" scale={scale} formatter={formatter} logScale={logScale} />
        ) : (
          <Loading>{state.error ?? (state.loading ? 'Loading…' : 'No data')}</Loading>
        )}
      </ChartArea>
    </Cell>
  );
};

// Grid cell for the multi-series Black Hole chart. Mirrors ChartCell's chrome
// (title, lin/log toggle, expand) but renders BlackholeChart from the
// multi-series payload instead of the single-series InnerChart path.
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
      <ChartArea>
        {filtered && filtered.length > 0 ? (
          <BlackholeChart series={filtered} logScale={logScale} formatter={formatter} />
        ) : (
          <Loading>{state.error ?? (state.loading ? 'Loading…' : 'No data')}</Loading>
        )}
      </ChartArea>
    </Cell>
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
}

export const NetworkCharts: React.FC = () => {
  const hashrate           = useOneShot<ApiChartSeries>(() => api.charts.hashrate());
  const difficulty         = useOneShot<ApiChartSeries>(() => api.charts.difficulty());
  const blockTime          = useOneShot<ApiChartSeries>(() => api.charts.blockTime());
  const coinbase           = useOneShot<ApiChartSeries>(() => api.charts.coinbase());
  const tvl                = useOneShot<ApiChartSeries>(() => api.charts.tvl());
  const dexVolume          = useOneShot<ApiChartSeries>(() => api.charts.dexVolume());
  const beamVol            = useOneShot<ApiChartSeries>(() => api.charts.beamVol());
  const dexVol             = useOneShot<ApiChartSeries>(() => api.charts.dexVol());

  // Cumulative DEX volume derived from the daily series — running sum.
  // Avoids a second backend round-trip and stays in lock-step with the
  // daily chart's methodology.
  const dexVolumeCumulative = useMemo<FetchState<ApiChartSeries>>(() => {
    if (!dexVolume.data) {
      return { data: null, loading: dexVolume.loading, error: dexVolume.error };
    }
    let acc = 0;
    const series = dexVolume.data.series.map((p) => {
      acc += p.value;
      return { ts: p.ts, value: acc };
    });
    return { data: { series }, loading: false, error: null };
  }, [dexVolume.data, dexVolume.loading, dexVolume.error]);
  const assets             = useOneShot<ApiChartSeries>(() => api.charts.assets());
  const transactionsDaily  = useOneShot<ApiChartSeries>(() => api.charts.transactionsDaily());
  const transactionsTotal  = useOneShot<ApiChartSeries>(() => api.charts.transactionsTotal());
  const txosTotal          = useOneShot<ApiChartSeries>(() => api.charts.txosTotal());
  const utxosTotal         = useOneShot<ApiChartSeries>(() => api.charts.utxosTotal());
  const shieldedInsDaily   = useOneShot<ApiChartSeries>(() => api.charts.shieldedInsDaily());
  const shieldedInsTotal   = useOneShot<ApiChartSeries>(() => api.charts.shieldedInsTotal());
  const shieldedOutsDaily  = useOneShot<ApiChartSeries>(() => api.charts.shieldedOutsDaily());
  const shieldedOutsTotal  = useOneShot<ApiChartSeries>(() => api.charts.shieldedOutsTotal());
  const contractsTotal     = useOneShot<ApiChartSeries>(() => api.charts.contractsTotal());
  const feesDaily          = useOneShot<ApiChartSeries>(() => api.charts.feesDaily());
  const feesTotal          = useOneShot<ApiChartSeries>(() => api.charts.feesTotal());
  const contractCallsDaily = useOneShot<ApiChartSeries>(() => api.charts.contractCallsDaily());
  const contractCallsTotal = useOneShot<ApiChartSeries>(() => api.charts.contractCallsTotal());
  const blackhole          = useOneShot<ApiBlackholeBody>(() => api.charts.blackhole());

  const [timeframe, setTimeframe] = useState<Timeframe>('ALL');
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [category, setCategory] = useState<Category>('blockchain');
  // The Confidential Assets icon strip opens decluttered — the AMM Liquidity
  // Tokens are hidden until the user toggles them on.
  const [hideAmml, setHideAmml] = useState(true);
  // Black Hole balances span ~8 orders of magnitude (0.01 → ~1e9) across
  // assets, so it opens on a log Y axis; everything else defaults to linear.
  const [logPerKey, setLogPerKey] = useState<Record<string, boolean>>({ blackhole: true });
  const toggleLog = (k: string): void =>
    setLogPerKey((m) => ({ ...m, [k]: !m[k] }));

  // Ordered so each "… / day" chart sits immediately before its "… (total)"
  // twin — the 2-column auto-flow Grid then renders them side-by-side on one
  // row (day on the left, total on the right). Charts without a day/total
  // twin are listed after the pairs so they fall below in each category.
  const allCharts: ReadonlyArray<ChartSpec & { category: Category }> = [
    // Blockchain — day/total pairs
    { key: 'transactionsDaily',title: 'Transactions / day',      state: transactionsDaily,  formatter: fmtInt,        category: 'blockchain', overlay: { state: coinbase, label: 'Coinbase' } },
    { key: 'transactionsTotal',title: 'Transactions (total)',    state: transactionsTotal,  formatter: fmtInt,        category: 'blockchain' },
    { key: 'feesDaily',        title: 'Fees / day',              state: feesDaily,          formatter: fmtBeam,       category: 'blockchain' },
    { key: 'feesTotal',        title: 'Fees (total)',            state: feesTotal,          formatter: fmtBeam,       category: 'blockchain' },
    { key: 'callsDaily',       title: 'Contract calls / day',    state: contractCallsDaily, formatter: fmtInt,        category: 'blockchain' },
    { key: 'callsTotal',       title: 'Contract calls (total)',  state: contractCallsTotal, formatter: fmtInt,        category: 'blockchain' },
    // Blockchain — standalone
    { key: 'hashrate',         title: 'Hashrate (Beamhash III)', state: hashrate,           formatter: fmtHashrate,   category: 'blockchain' },
    { key: 'difficulty',       title: 'Difficulty',              state: difficulty,         formatter: fmtDifficulty, category: 'blockchain' },
    { key: 'blockTime',        title: 'Avg block time',          state: blockTime,          formatter: fmtBlockTime,  category: 'blockchain' },
    { key: 'txosTotal',        title: 'TXOs (total)',            state: txosTotal,          formatter: fmtInt,        category: 'blockchain' },
    { key: 'utxosTotal',       title: 'UTXOs',                   state: utxosTotal,         formatter: fmtInt,        category: 'blockchain' },
    { key: 'contractsTotal',   title: 'Contracts active',        state: contractsTotal,     formatter: fmtInt,        category: 'blockchain' },
    { key: 'assets',           title: 'Confidential Assets',     state: assets,             formatter: fmtInt,        category: 'blockchain' },
    // Lelantus — day/total pairs
    { key: 'shieldedIns',       title: 'Shielded inputs / day',  state: shieldedInsDaily,   formatter: fmtInt,        category: 'lelantus' },
    { key: 'shieldedInsTotal',  title: 'Shielded inputs (total)',state: shieldedInsTotal,   formatter: fmtInt,        category: 'lelantus' },
    { key: 'shieldedOuts',      title: 'Shielded outputs / day', state: shieldedOutsDaily,  formatter: fmtInt,        category: 'lelantus' },
    { key: 'shieldedOutsTotal', title: 'Shielded outputs (total)',state: shieldedOutsTotal,  formatter: fmtInt,        category: 'lelantus' },
    // DeFi — day/total pairs
    { key: 'dexVolume',          title: 'DEX volume / day',       state: dexVolume,          formatter: fmtUsd, category: 'defi' },
    { key: 'dexVolumeCumulative',title: 'DEX volume (total)',     state: dexVolumeCumulative,formatter: fmtUsd, category: 'defi' },
    // DeFi — standalone
    { key: 'tvl',                title: 'DEX TVL',                state: tvl,                formatter: fmtUsd, category: 'defi' },
    { key: 'beamVol',            title: 'BEAM Volatility Index (30d)', state: beamVol,       formatter: fmtVol, category: 'defi' },
    { key: 'dexVol',             title: 'DEX Volatility Index (30d)',  state: dexVol,        formatter: fmtVol, category: 'defi' },
    { key: 'blackhole',          title: 'Black Hole (assets locked)',  multiState: blackhole, formatter: fmtNative, category: 'defi' },
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
      const svg = blackholeSvg(filtered, expanded.title, expanded.formatter, !!logPerKey[expanded.key]);
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
    const svg = toSvg(filtered, expanded.title, expanded.formatter, expanded.scale ?? 1);
    if (format === 'svg') downloadBlob(svg, `${base}.svg`, 'image/svg+xml');
    else downloadSvgAsPng(svg, `${base}.png`);
  };

  useEffect(() => {
    if (!expanded) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setExpandedKey(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);

  return (
    <Page>
      <Toolbar>
        <CategoryBar>
          {CATEGORIES.map((c) => (
            <TfButton
              key={c.key}
              active={category === c.key}
              onClick={() => setCategory(c.key)}
            >
              {c.label}
            </TfButton>
          ))}
        </CategoryBar>
        <TimeframeGroup>
          {TIMEFRAMES.map((tf) => (
            <TfButton
              key={tf}
              active={timeframe === tf}
              onClick={() => setTimeframe(tf)}
            >
              {tf}
            </TfButton>
          ))}
        </TimeframeGroup>
      </Toolbar>
      <Grid>
        {charts.map((c) => (
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
              onExpand={() => setExpandedKey(c.key)}
              onToggleLog={() => toggleLog(c.key)}
            />
          )
        ))}
      </Grid>
      {expanded && (
        <ModalBackdrop onClick={() => setExpandedKey(null)}>
          <ModalContent onClick={(e) => e.stopPropagation()}>
            <CloseButton onClick={() => setExpandedKey(null)} aria-label="Close">×</CloseButton>
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
              <TimeframeGroup>
                {TIMEFRAMES.map((tf) => (
                  <TfButton
                    key={tf}
                    active={timeframe === tf}
                    onClick={() => setTimeframe(tf)}
                  >
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
                  chartKey={expanded.key}
                  state={expanded.state!}
                  title={expanded.title}
                  timeframe={timeframe}
                  scale={expanded.scale}
                  formatter={expanded.formatter}
                  logScale={!!logPerKey[expanded.key]}
                  hideAmml={hideAmml}
                  overlay={expanded.overlay}
                />
              )}
            </ModalBody>
          </ModalContent>
        </ModalBackdrop>
      )}
    </Page>
  );
};

const ExpandedChart: React.FC<
  Omit<ChartCellProps, 'onExpand'> & { overlay?: { state: FetchState<ApiChartSeries>; label: string } }
> = ({ chartKey, state, title, timeframe, scale, formatter, logScale, hideAmml, overlay }) => {
  const filtered = useMemo(
    () => (state.data ? filterByTimeframe(state.data.series, timeframe) : null),
    [state.data, timeframe],
  );
  const filteredOverlay = useMemo(
    () => (overlay?.state.data ? filterByTimeframe(overlay.state.data.series, timeframe) : null),
    [overlay?.state.data, timeframe],
  );
  if (!filtered) return <Loading>{state.error ?? (state.loading ? 'Loading…' : 'No data')}</Loading>;
  return (
    <InnerChart
      chartKey={chartKey}
      expanded
      series={filtered}
      title={title}
      scale={scale}
      formatter={formatter}
      logScale={logScale}
      hideAmml={hideAmml}
      overlaySeries={filteredOverlay ?? undefined}
      overlayLabel={overlay?.label}
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
    return <Loading>{state.error ?? (state.loading ? 'Loading…' : 'No data')}</Loading>;
  }
  return <BlackholeChart series={filtered} logScale={logScale} formatter={formatter} />;
};

// IndexerStatusBadge lives in the global Footer (components/Footer.tsx) now.

export default NetworkCharts;
