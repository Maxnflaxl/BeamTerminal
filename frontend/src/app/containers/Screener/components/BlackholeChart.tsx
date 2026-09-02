import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { styled } from '@linaria/react';
import {
  LineStyle,
  LineType,
  PriceScaleMode,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type UTCTimestamp,
} from 'lightweight-charts';
import AssetIcon, { normalizeOptColor } from '@app/shared/components/AssetsIcon';
import { PALLETE_ASSETS } from '@app/shared/constants';
import { clearChildren, createBeamChart, makeSpan } from './chartTheme';
import type { ApiBlackholeSeries } from '../api/client';
import type { ApiAssetListEntry } from '../api/types';
import { useSharedAssets } from '../assetColors';
import { fmtDayLocal, fmtNativeUnits } from './format';

// Colour per asset — the asset's brand colour (OPT_COLOR) when known, otherwise
// the same per-aid palette slot AssetIcon falls back to, so the line, its legend
// swatch, and the asset icon all share one colour. Exported so the SVG/PNG
// export agrees with the on-screen chart.
export function buildBlackholeColors(series: ReadonlyArray<ApiBlackholeSeries>): Map<number, string> {
  const map = new Map<number, string>();
  for (const s of series) {
    const color = normalizeOptColor(s.color) ?? PALLETE_ASSETS[s.aid] ?? PALLETE_ASSETS[s.aid % PALLETE_ASSETS.length]!;
    map.set(s.aid, color);
  }
  return map;
}

export type BlackholeLineStyle = 'solid' | 'dashed' | 'dotted' | 'large-dashed';
const STYLE_CYCLE: BlackholeLineStyle[] = ['solid', 'dashed', 'dotted', 'large-dashed'];

// Paired confidential assets are burned in lockstep, so their cumulative curves
// coincide and draw on the same pixels — one line hides the other. Bucket series
// by final value (~3 significant figures) and give each member of a multi-asset
// bucket a distinct line style, so overlapping lines stay individually legible.
// Exported so the chart, legend, and SVG/PNG export agree on the assignment.
export function buildBlackholeLineStyles(series: ReadonlyArray<ApiBlackholeSeries>): Map<number, BlackholeLineStyle> {
  const buckets = new Map<string, number[]>();
  for (const s of series) {
    const v = s.points[s.points.length - 1]?.value ?? 0;
    const key = v === 0 ? '0' : v.toPrecision(3);
    const list = buckets.get(key);
    if (list) list.push(s.aid);
    else buckets.set(key, [s.aid]);
  }
  const out = new Map<number, BlackholeLineStyle>();
  for (const aids of buckets.values()) {
    aids.forEach((aid, i) => out.set(aid, aids.length > 1 ? STYLE_CYCLE[i % STYLE_CYCLE.length]! : 'solid'));
  }
  return out;
}

const LINE_STYLE_ENUM: Record<BlackholeLineStyle, LineStyle> = {
  solid: LineStyle.Solid,
  dashed: LineStyle.Dashed,
  dotted: LineStyle.Dotted,
  'large-dashed': LineStyle.LargeDashed,
};
// CSS border-style for the legend swatch (CSS has no large-dashed → dashed).
const LINE_STYLE_CSS: Record<BlackholeLineStyle, React.CSSProperties['borderTopStyle']> = {
  solid: 'solid',
  dashed: 'dashed',
  dotted: 'dotted',
  'large-dashed': 'dashed',
};
// SVG stroke-dasharray for the PNG/SVG export ('' = solid).
export const LINE_STYLE_DASH: Record<BlackholeLineStyle, string> = {
  solid: '',
  dashed: '6 4',
  dotted: '2 3',
  'large-dashed': '10 5',
};

const ICON_PX = 20;

// lightweight-charts spaces bars by *index*, not by elapsed time. Each asset
// contributes only a handful of deposits at irregular moments, so plotting the
// raw points makes one pixel worth anything from an hour to a year — the axis
// is distorted and the crosshair leaps months between adjacent pixels. Forward
// -fill every series onto one shared, near-uniform grid (all real event
// timestamps, plus a regular step between them) so the cursor moves smoothly
// and every asset has a readable value at whatever instant is hovered.
const GRID_TARGET_POINTS = 600;

// Row height and header+padding of the crosshair tooltip, used to work out how
// many rows fit the plot before the list has to be windowed.
const TIP_ROW_PX = 14;
const TIP_CHROME_PX = 32;

export function resampleBlackhole(series: ReadonlyArray<ApiBlackholeSeries>): Map<number, LineData[]> {
  const out = new Map<number, LineData[]>();
  const times = new Set<number>();
  let min = Infinity;
  let max = -Infinity;
  for (const s of series) {
    for (const p of s.points) {
      times.add(p.ts);
      if (p.ts < min) min = p.ts;
      if (p.ts > max) max = p.ts;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return out;
  const step = Math.max(60, Math.floor((max - min) / GRID_TARGET_POINTS));
  for (let t = min + step; t < max; t += step) times.add(t);
  const grid = Array.from(times).sort((a, b) => a - b);

  for (const s of series) {
    const pts = s.points.slice().sort((a, b) => a.ts - b.ts);
    const data: LineData[] = [];
    let i = 0;
    let cur: number | null = null;
    for (const t of grid) {
      while (i < pts.length && pts[i]!.ts <= t) {
        cur = pts[i]!.value;
        i += 1;
      }
      // Nothing burned yet — the line starts at the asset's first deposit.
      if (cur == null) continue;
      data.push({ time: t as UTCTimestamp, value: cur });
    }
    out.set(s.aid, data);
  }
  return out;
}

const Wrap = styled.div`
  width: 100%;
  height: 100%;
  min-height: 220px;
  display: flex;
  flex-direction: column;
`;

// Legend strip above the plot. Wraps to multiple rows and scrolls if it
// overflows, so it never eats the whole cell. flex/grid `gap` isn't supported
// on the wallet's QtWebEngine 5.15.2 (Chrome 83) — use margins.
const Legend = styled.div`
  flex: 0 0 auto;
  max-height: 84px;
  overflow-y: auto;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  padding: 2px 2px 6px;
  font-family: var(--font-mono);
  font-size: 11px;
`;

const LegendItem = styled.button<{ off?: boolean }>`
  display: inline-flex;
  align-items: center;
  background: transparent;
  border: 0;
  padding: 2px 4px;
  margin: 0 8px 2px 0;
  cursor: pointer;
  color: ${(p) => (p.off ? 'rgba(255,255,255,0.32)' : 'rgba(255,255,255,0.78)')};
  font-family: inherit;
  font-size: 11px;

  & > i {
    display: inline-block;
    width: 14px;
    height: 0;
    margin-right: 5px;
    border-top-width: 2px;
    border-top-style: solid;
    opacity: ${(p) => (p.off ? 0.35 : 1)};
  }

  & > .aid {
    margin-left: 4px;
    color: rgba(255, 255, 255, 0.4);
  }

  &:hover {
    color: #00f6d2;
  }
`;

// Relative wrapper so the icon overlay can be absolutely positioned over the
// chart plot (and only the plot — not the legend).
const Plot = styled.div`
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  width: 100%;
`;

const Inner = styled.div`
  width: 100%;
  height: 100%;
`;

// Crosshair readout: every visible asset's cumulative burned amount at the
// hovered instant, biggest first, with the line nearest the cursor highlighted
// so a single asset can be followed across the plot. Positioned imperatively
// (translate3d) from the crosshair handler — no React render per mouse move.
const Tooltip = styled.div`
  position: absolute;
  top: 0;
  left: 0;
  z-index: 6;
  display: none;
  max-width: 260px;
  max-height: 100%;
  overflow: hidden;
  padding: 6px 8px;
  border: 1px solid rgba(0, 246, 210, 0.28);
  border-radius: 6px;
  background: rgba(4, 26, 51, 0.94);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5);
  pointer-events: none;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 14px;
  white-space: nowrap;

  & > .when {
    margin-bottom: 4px;
    color: rgba(255, 255, 255, 0.55);
  }

  & > .row {
    display: flex;
    align-items: center;
    color: rgba(255, 255, 255, 0.6);
  }

  & > .row.on {
    color: rgba(255, 255, 255, 0.95);
  }

  & > .row.rest {
    padding-left: 16px;
    color: rgba(255, 255, 255, 0.4);
  }

  & > .row > .sw {
    flex: 0 0 auto;
    width: 10px;
    height: 0;
    margin-right: 6px;
    border-top-width: 2px;
  }

  & > .row > .lbl {
    flex: 1 1 auto;
    margin-right: 12px;
  }

  & > .row > .val {
    flex: 0 0 auto;
    margin-left: auto;
  }
`;

// Overlay layer for the line-end asset icons. Spelled-out edges (no `inset`
// shorthand on Chrome 83). pointer-events:none so panning passes through; the
// chips re-enable it for themselves.
const Strip = styled.div`
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  pointer-events: none;
  z-index: 2;
`;

// Zero-size anchor positioned imperatively via translate3d (compositor-only,
// no reflow per frame). The chip centres itself on the anchor.
const MarkerAnchor = styled.div`
  position: absolute;
  top: 0;
  left: 0;
  width: 0;
  height: 0;
`;

const MarkerChip = styled.div`
  --marker-scale: 1;
  position: absolute;
  top: 0;
  left: 0;
  width: ${ICON_PX}px;
  height: ${ICON_PX}px;
  transform: translate(-50%, -50%) scale(var(--marker-scale));
  pointer-events: auto;
  cursor: pointer;
  border-radius: 50%;
  background: #042548;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.18), 0 1px 2px rgba(0, 0, 0, 0.6);
  transition: transform 120ms, box-shadow 120ms;

  & > * {
    margin: 0 !important;
    width: 100% !important;
    height: 100% !important;
  }

  /* Kept as two separate blocks: :focus-visible is Chrome 86+, and inside a
     selector list it would invalidate the whole rule in the wallet (Chrome 83),
     killing the :hover state too. */
  &:hover {
    --marker-scale: 1.18;
    box-shadow: 0 0 0 1px rgba(0, 246, 210, 0.65), 0 2px 6px rgba(0, 0, 0, 0.7);
    z-index: 5;
    outline: none;
  }

  &:focus-visible {
    --marker-scale: 1.18;
    box-shadow: 0 0 0 1px rgba(0, 246, 210, 0.65), 0 2px 6px rgba(0, 0, 0, 0.7);
    z-index: 5;
    outline: none;
  }
`;

const Popover = styled.div`
  position: absolute;
  z-index: 20;
  width: 220px;
  background: #0a3163;
  border: 1px solid rgba(0, 246, 210, 0.35);
  border-radius: 8px;
  padding: 10px 12px;
  color: rgba(255, 255, 255, 0.92);
  font-family: var(--font-mono);
  font-size: 12px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.55);
  pointer-events: auto;
`;

const PopHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
  & > * + * {
    margin-left: 8px;
  }
`;

const PopTitle = styled.div`
  display: flex;
  align-items: center;
  min-width: 0;

  & > .icon {
    flex-shrink: 0;
    width: 22px;
    height: 22px;
    margin-right: 8px;
  }
  & > .icon > * {
    margin: 0 !important;
  }
`;

const PopName = styled.div`
  display: flex;
  flex-direction: column;
  min-width: 0;
`;

const PopNameMain = styled.div`
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;

const PopNameSub = styled.div`
  font-size: 10px;
  color: rgba(255, 255, 255, 0.55);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;

const ArrowButton = styled.button`
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 246, 210, 0.12);
  color: #00f6d2;
  border: 1px solid rgba(0, 246, 210, 0.45);
  border-radius: 4px;
  cursor: pointer;
  padding: 0;
  flex-shrink: 0;

  &:hover {
    background: rgba(0, 246, 210, 0.22);
    border-color: rgba(0, 246, 210, 0.75);
  }
`;

const PopRow = styled.div`
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.65);
  & + & {
    margin-top: 2px;
  }

  & > .v {
    color: rgba(255, 255, 255, 0.92);
    margin-left: 8px;
  }
`;

const PopDesc = styled.div`
  margin-top: 6px;
  font-size: 11px;
  line-height: 1.35;
  color: rgba(255, 255, 255, 0.7);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
`;

const ArrowIcon: React.FC = () => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 12 12"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <line x1="2" y1="6" x2="10" y2="6" />
    <polyline points="6 2 10 6 6 10" />
  </svg>
);

function fmtBurned(v: number): string {
  return v.toLocaleString('en-US', { maximumFractionDigits: v >= 1 ? 2 : 8 });
}

interface Props {
  series: ReadonlyArray<ApiBlackholeSeries>;
  logScale?: boolean;
  formatter?: (v: number) => string;
  /** Render the line-end asset-icon overlay (hover for metadata + amount
   *  burned, click to open the asset). Only enabled in the expanded modal —
   *  15 icons don't fit a 320px grid cell, which keeps its colour legend. */
  showMarkers?: boolean;
}

export const BlackholeChart: React.FC<Props> = ({
  series,
  logScale = false,
  formatter = fmtNativeUnits,
  showMarkers = false,
}) => {
  const innerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<Map<number, ISeriesApi<'Line'>>>(new Map());
  const markerNodes = useRef<Map<number, HTMLDivElement>>(new Map());
  // Latest screen position per visible marker — read by the popover.
  const placedRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  // Last-written transform signature per marker, so the per-frame reposition
  // loop only touches the DOM when a marker actually moves.
  const writtenRef = useRef<Map<number, string>>(new Map());
  // Pinned price range (full extent of the visible series), read by each
  // series' autoscaleInfoProvider so horizontal panning doesn't rescale the
  // y-axis on every frame. Kept in a ref so the providers see the latest value.
  const priceRangeRef = useRef<{ min: number; max: number } | null>(null);
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const [hoverAid, setHoverAid] = useState<number | null>(null);
  const hoverTimer = useRef<number | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  // Cached tooltip rows, keyed by aid, so a mouse move rewrites text instead of
  // rebuilding 16 elements per frame. `sig` is the aid order they were built in.
  const tipRowsRef = useRef<{
    sig: string;
    when: HTMLDivElement | null;
    rows: Map<number, { row: HTMLDivElement; val: HTMLSpanElement }>;
  }>({ sig: '', when: null, rows: new Map() });
  // Series currently thickened under the crosshair.
  const focusedRef = useRef<number | null>(null);
  const navigate = useNavigate();

  const { data: assetsData } = useSharedAssets();
  const metaByAid = useMemo(() => {
    const map = new Map<number, ApiAssetListEntry>();
    if (assetsData) for (const a of assetsData.assets) map.set(a.aid, a);
    return map;
  }, [assetsData]);

  // Stable colour + line style per asset (series order is stable per load).
  const colorByAid = useMemo(() => buildBlackholeColors(series), [series]);
  const styleByAid = useMemo(() => buildBlackholeLineStyles(series), [series]);

  // Uniform-grid line data (see resampleBlackhole) — what actually gets plotted.
  // `series` keeps its raw points for the legend, markers and popover.
  const chartData = useMemo(() => resampleBlackhole(series), [series]);

  // Latest render's view state for the imperative crosshair handler, which is
  // subscribed once per chart and must not close over stale values.
  const viewRef = useRef({ series, colorByAid, hidden, formatter });
  viewRef.current = { series, colorByAid, hidden, formatter };

  // Full price extent across the *visible* series (recomputed only when the
  // data or legend selection changes — never on pan). Padded slightly in log
  // space so the top/bottom lines aren't flush against the frame.
  const priceRange = useMemo(() => {
    let min = Infinity;
    let max = -Infinity;
    for (const s of series) {
      if (hidden.has(s.aid)) continue;
      for (const p of s.points) {
        if (p.value > 0) {
          if (p.value < min) min = p.value;
          if (p.value > max) max = p.value;
        }
      }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
    return { min: min * 0.6, max: max * 1.6 };
  }, [series, hidden]);

  // Push the pinned range to the providers and re-run the auto-scale so the
  // y-axis settles on the new (stable) extent when the selection changes.
  useEffect(() => {
    priceRangeRef.current = priceRange;
    chartRef.current?.priceScale('right').applyOptions({ autoScale: true });
  }, [priceRange]);
  // Imperative reposition: every icon sits at its line's BEGIN — the first
  // point's (timeToCoordinate, priceToCoordinate). Markers whose begin is
  // scrolled out of the plot are hidden; the few that still overlap (e.g. paired
  // assets whose first deposits coincide) are nudged apart vertically.
  const updatePositions = useCallback((): void => {
    const chart = chartRef.current;
    const host = innerRef.current;
    if (!chart || !host) return;
    const ts = chart.timeScale();
    const plotW = ts.width();
    // priceToCoordinate maps into the price pane, which sits *above* the
    // time-axis strip; exclude that strip so icons stay inside the plot.
    const paneH = Math.max(0, host.clientHeight - ts.height());
    const half = ICON_PX / 2;

    const placed: Array<{ aid: number; x: number; y: number }> = [];
    for (const s of series) {
      if (hidden.has(s.aid)) continue;
      const line = seriesRef.current.get(s.aid);
      const first = s.points[0];
      if (!line || !first) continue;
      const x = ts.timeToCoordinate(first.ts as UTCTimestamp);
      const y = line.priceToCoordinate(first.value);
      // Drop markers whose begin is off the plot in either axis (±1px grace so a
      // begin resting on the left edge in a zoomed timeframe doesn't flicker).
      if (x == null || y == null || x < -1 || x > plotW + 1 || y < 0 || y > paneH) continue;
      placed.push({ aid: s.aid, x, y });
    }
    // Nudge icons that overlap in *both* axes downward until clear. Begins are
    // mostly scattered, so only near-coincident ones move. O(n²), n≈15.
    placed.sort((a, b) => a.y - b.y);
    const minGap = ICON_PX + 1;
    for (let i = 0; i < placed.length; i += 1) {
      for (let j = 0; j < i; j += 1) {
        if (Math.abs(placed[i]!.x - placed[j]!.x) < ICON_PX && placed[i]!.y < placed[j]!.y + minGap) {
          placed[i]!.y = placed[j]!.y + minGap;
        }
      }
    }

    const next = new Map<number, { x: number; y: number }>();
    const written = writtenRef.current;
    const posByAid = new Map(placed.map((p) => [p.aid, p]));
    for (const s of series) {
      const el = markerNodes.current.get(s.aid);
      if (!el) continue;
      const p = posByAid.get(s.aid);
      if (!p) {
        if (written.get(s.aid) !== 'hidden') {
          el.style.display = 'none';
          written.set(s.aid, 'hidden');
        }
        continue;
      }
      const cx = Math.min(Math.max(p.x, half), plotW - half);
      const cy = Math.min(Math.max(p.y, half), paneH - half);
      const sig = `${cx.toFixed(1)}:${cy.toFixed(1)}`;
      if (written.get(s.aid) !== sig) {
        el.style.display = '';
        el.style.transform = `translate3d(${cx}px, ${cy}px, 0)`;
        written.set(s.aid, sig);
      }
      next.set(s.aid, { x: cx, y: cy });
    }
    placedRef.current = next;
  }, [series, hidden]);

  const updatePositionsRef = useRef(updatePositions);
  useEffect(() => {
    updatePositionsRef.current = updatePositions;
  }, [updatePositions]);

  // Re-create the chart only when the formatter changes (it's applied at
  // construction). logScale / data / visibility are handled by the dedicated
  // effects below so toggling them doesn't drop the data.
  useEffect(() => {
    const el = innerRef.current;
    if (!el) return undefined;
    const chart = createBeamChart(el, {
      // Pin the price-axis gutter width. Without this, the gutter resizes as
      // tick labels change width during a vertical drag ("5.00k" → "500.00M"),
      // reflowing the whole plot every frame — the "erratic" y-axis flicker.
      rightPriceScale: { minimumWidth: 88 },
      timeScale: { minBarSpacing: 0.01 },
    });
    chartRef.current = chart;

    // Crosshair readout. Every series is defined at every grid point, so the
    // whole burn ledger can be read off one instant; the line whose value sits
    // closest to the cursor is highlighted and thickened, which is what makes a
    // single asset followable through the bundle of overlapping curves.
    chart.subscribeCrosshairMove((param) => {
      const tip = tooltipRef.current;
      const host = innerRef.current;
      if (!tip || !host) return;
      const { series: ser, colorByAid: colors, hidden: hid, formatter: fmt } = viewRef.current;

      const rows: Array<{ aid: number; label: string; value: number; y: number | null }> = [];
      if (param && param.time != null && param.point) {
        for (const s of ser) {
          if (hid.has(s.aid)) continue;
          const line = seriesRef.current.get(s.aid);
          if (!line) continue;
          const d = param.seriesData.get(line) as { value?: number } | undefined;
          if (!d || typeof d.value !== 'number') continue;
          rows.push({ aid: s.aid, label: s.label, value: d.value, y: line.priceToCoordinate(d.value) });
        }
      }

      if (rows.length === 0) {
        tip.style.display = 'none';
        if (focusedRef.current != null) {
          focusedRef.current = null;
          for (const line of seriesRef.current.values()) line.applyOptions({ lineWidth: 2 });
        }
        return;
      }

      rows.sort((a, b) => b.value - a.value);
      let focus: number | null = null;
      let best = Infinity;
      for (const r of rows) {
        if (r.y == null) continue;
        const d = Math.abs(r.y - param.point!.y);
        if (d < best) {
          best = d;
          focus = r.aid;
        }
      }
      if (focus !== focusedRef.current) {
        focusedRef.current = focus;
        for (const [aid, line] of seriesRef.current) line.applyOptions({ lineWidth: aid === focus ? 3 : 2 });
      }

      // A short grid cell can't show 15 rows — keep a window around the line
      // under the cursor (the one being followed) and count the rest.
      const maxRows = Math.max(3, Math.floor((host.clientHeight - TIP_CHROME_PX) / TIP_ROW_PX));
      let shown = rows;
      let more = 0;
      if (rows.length > maxRows) {
        const fi = Math.max(
          0,
          rows.findIndex((r) => r.aid === focus),
        );
        const span = maxRows - 1;
        const start = Math.min(Math.max(0, fi - Math.floor(span / 2)), rows.length - span);
        shown = rows.slice(start, start + span);
        more = rows.length - shown.length;
      }

      // Rebuild the row elements only when the set/order of assets changes.
      const sig = `${shown.map((r) => r.aid).join(',')}|${more}`;
      const cache = tipRowsRef.current;
      if (cache.sig !== sig) {
        clearChildren(tip);
        cache.rows = new Map();
        cache.sig = sig;
        const whenRow = document.createElement('div');
        whenRow.className = 'when';
        tip.appendChild(whenRow);
        cache.when = whenRow;
        for (const r of shown) {
          const row = document.createElement('div');
          row.className = 'row';
          const sw = makeSpan('sw');
          sw.style.borderTopStyle = 'solid';
          sw.style.borderTopColor = colors.get(r.aid) ?? '#fff';
          const lbl = makeSpan('lbl', `${r.label} #${r.aid}`);
          const val = makeSpan('val');
          row.appendChild(sw);
          row.appendChild(lbl);
          row.appendChild(val);
          tip.appendChild(row);
          cache.rows.set(r.aid, { row, val });
        }
        if (more > 0) {
          const rest = document.createElement('div');
          rest.className = 'row rest';
          rest.appendChild(makeSpan('lbl', `+${more} more`));
          tip.appendChild(rest);
        }
      }
      if (cache.when) cache.when.textContent = fmtDayLocal(param.time as number);
      for (const r of shown) {
        const node = cache.rows.get(r.aid);
        if (!node) continue;
        node.val.textContent = fmt(r.value);
        node.row.className = r.aid === focus ? 'row on' : 'row';
      }

      tip.style.display = 'block';
      const w = tip.offsetWidth;
      const h = tip.offsetHeight;
      const right = param.point!.x + 16;
      const x = right + w <= host.clientWidth ? right : Math.max(4, param.point!.x - 16 - w);
      const y = Math.min(Math.max(4, param.point!.y - h / 2), Math.max(4, host.clientHeight - h - 4));
      tip.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    });

    // Keep the line-end icons glued to the lines every frame. lightweight-charts
    // fires no event for price-scale (vertical) pan/zoom or autoScale settling,
    // so the time-range subscriptions alone left icons stranded on vertical
    // moves. A rAF poll is the only thing that tracks every coordinate change;
    // updatePositions writes to the DOM only when a marker actually moves, so an
    // idle chart costs just the coordinate reads, and the browser pauses rAF when
    // the tab is hidden. Only runs when the icon overlay is shown.
    let raf = 0;
    if (showMarkers) {
      raf = requestAnimationFrame(function tick() {
        updatePositionsRef.current();
        raf = requestAnimationFrame(tick);
      });
    }

    return () => {
      if (raf) cancelAnimationFrame(raf);
      chart.remove();
      chartRef.current = null;
      seriesRef.current.clear();
    };
  }, [formatter, showMarkers]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.priceScale('right').applyOptions({
      mode: logScale ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal,
    });
    // The rAF reposition loop picks up the new coordinates next frame.
  }, [logScale]);

  // (Re)build the line set whenever the data changes. Cheap — one fetch per
  // page load — so we drop all series and re-add rather than diffing.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return undefined;
    for (const s of seriesRef.current.values()) chart.removeSeries(s);
    seriesRef.current.clear();
    for (const s of series) {
      const line = chart.addLineSeries({
        color: colorByAid.get(s.aid),
        lineWidth: 2,
        lineStyle: LINE_STYLE_ENUM[styleByAid.get(s.aid) ?? 'solid'],
        // A burn is a discrete jump, not a ramp — and never a curve, whose
        // overshoot would draw a dip the balance can't actually take.
        lineType: LineType.WithSteps,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: true,
        visible: !hidden.has(s.aid),
        priceFormat: { type: 'custom', formatter, minMove: 0.00000001 },
        // Pin auto-scale to the whole-series extent so sideways panning never
        // rescales the y-axis. Returns null until the range is known, and is
        // ignored once the user manually drags the price axis (autoScale off).
        autoscaleInfoProvider: () => {
          const r = priceRangeRef.current;
          return r ? { priceRange: { minValue: r.min, maxValue: r.max } } : null;
        },
      });
      line.setData(chartData.get(s.aid) ?? []);
      seriesRef.current.set(s.aid, line);
    }
    if (series.length === 0) return undefined;
    const ts = chart.timeScale();
    ts.fitContent();
    // The expanded modal mounts the chart before its layout settles, and
    // fitContent on a zero-width plot leaves the whole range squeezed into a
    // sliver at the right edge. Retry until the plot actually has a width
    // (bounded, so a chart that never gets one doesn't spin forever).
    let raf = 0;
    let tries = 0;
    const refit = (): void => {
      tries += 1;
      if (ts.width() > 0 || tries > 120) {
        if (ts.width() > 0) ts.fitContent();
        return;
      }
      raf = requestAnimationFrame(refit);
    };
    raf = requestAnimationFrame(refit);
    // The rAF reposition loop re-places the icons once the new scale settles.
    // `hidden` is intentionally omitted — visibility is applied by the effect
    // below so toggling a legend item doesn't rebuild every series.
    return () => {
      if (raf) cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, chartData, colorByAid, styleByAid, formatter]);

  useEffect(() => {
    for (const [aid, line] of seriesRef.current) {
      line.applyOptions({ visible: !hidden.has(aid) });
    }
    // The rAF loop hides/shows the corresponding markers next frame.
  }, [hidden]);

  useEffect(
    () => () => {
      if (hoverTimer.current != null) window.clearTimeout(hoverTimer.current);
    },
    [],
  );

  const openHover = useCallback((aid: number): void => {
    if (hoverTimer.current != null) window.clearTimeout(hoverTimer.current);
    setHoverAid(aid);
  }, []);
  const closeHoverSoon = useCallback((): void => {
    if (hoverTimer.current != null) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => setHoverAid(null), 120);
  }, []);

  const toggle = (aid: number): void => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(aid)) next.delete(aid);
      else next.add(aid);
      // A hidden series shouldn't keep its popover open.
      return next;
    });
    setHoverAid((cur) => (cur === aid ? null : cur));
  };

  // Double-click isolates one asset (everything else off), and a second
  // double-click brings them all back. The two single clicks that precede it
  // toggle the same aid twice — a net no-op — so this needs no click timer.
  const isolate = (aid: number): void => {
    setHidden((prev) => {
      const alone = !prev.has(aid) && series.every((s) => s.aid === aid || prev.has(s.aid));
      return alone ? new Set<number>() : new Set(series.filter((s) => s.aid !== aid).map((s) => s.aid));
    });
    setHoverAid(null);
  };

  const go = (aid: number): void => navigate(`/asset/${aid}`);

  const hoverPos = hoverAid != null ? placedRef.current.get(hoverAid) : undefined;
  const hoverMeta = hoverAid != null ? metaByAid.get(hoverAid) : undefined;
  const hoverSeries = hoverAid != null ? series.find((s) => s.aid === hoverAid) : undefined;
  // Begin markers can sit anywhere; open the popover toward whichever side has
  // room (it spilled off the left edge when forced left for a left-side icon).
  const POPOVER_W = 220;
  const hoverRight = hoverPos != null && hoverPos.x + 12 + POPOVER_W <= (innerRef.current?.clientWidth ?? 0);

  return (
    <Wrap>
      <Legend>
        {series.map((s) => (
          <LegendItem
            key={s.aid}
            type="button"
            off={hidden.has(s.aid)}
            onClick={() => toggle(s.aid)}
            onDoubleClick={() => isolate(s.aid)}
            title={`${hidden.has(s.aid) ? 'Show' : 'Hide'} ${s.label} — double-click to show only this`}
          >
            <i
              style={{
                borderTopColor: colorByAid.get(s.aid),
                borderTopStyle: LINE_STYLE_CSS[styleByAid.get(s.aid) ?? 'solid'],
              }}
            />
            {s.label}
            <span className="aid">#{s.aid}</span>
          </LegendItem>
        ))}
      </Legend>
      <Plot>
        <Inner ref={innerRef} />
        <Tooltip ref={tooltipRef} />
        {showMarkers ? (
          <Strip>
            {series.map((s) => {
              const meta = metaByAid.get(s.aid);
              return (
                <MarkerAnchor
                  key={s.aid}
                  ref={(el) => {
                    if (el) markerNodes.current.set(s.aid, el);
                    else markerNodes.current.delete(s.aid);
                  }}
                  style={{ display: 'none' }}
                >
                  <MarkerChip
                    role="button"
                    tabIndex={0}
                    aria-label={`Open ${s.label} (#${s.aid})`}
                    onMouseEnter={() => openHover(s.aid)}
                    onMouseLeave={closeHoverSoon}
                    onFocus={() => openHover(s.aid)}
                    onBlur={closeHoverSoon}
                    onClick={() => go(s.aid)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        go(s.aid);
                      }
                    }}
                  >
                    <AssetIcon
                      asset_id={s.aid}
                      color={s.color ?? meta?.color ?? null}
                      logoUrl={meta?.logo_url ?? null}
                      size={ICON_PX}
                    />
                  </MarkerChip>
                </MarkerAnchor>
              );
            })}
            {hoverAid != null && hoverPos && hoverSeries ? (
              <Popover
                style={
                  hoverRight
                    ? { left: `${hoverPos.x + 12}px`, top: `${hoverPos.y}px`, transform: 'translateY(-50%)' }
                    : {
                        left: `${Math.max(4, hoverPos.x - 12)}px`,
                        top: `${hoverPos.y}px`,
                        transform: 'translate(-100%, -50%)',
                      }
                }
                onMouseEnter={() => openHover(hoverAid)}
                onMouseLeave={closeHoverSoon}
              >
                <PopHeader>
                  <PopTitle>
                    <span className="icon">
                      <AssetIcon
                        asset_id={hoverAid}
                        color={hoverSeries.color ?? hoverMeta?.color ?? null}
                        logoUrl={hoverMeta?.logo_url ?? null}
                        size={22}
                      />
                    </span>
                    <PopName>
                      <PopNameMain>{hoverMeta?.name ?? hoverSeries.label}</PopNameMain>
                      <PopNameSub>
                        {[hoverMeta?.short_name ?? hoverSeries.label, hoverMeta?.unit_name, `aid ${hoverAid}`]
                          .filter(Boolean)
                          .join(' · ')}
                      </PopNameSub>
                    </PopName>
                  </PopTitle>
                  <ArrowButton
                    type="button"
                    onClick={() => go(hoverAid)}
                    title="Open asset details"
                    aria-label="Open asset details"
                  >
                    <ArrowIcon />
                  </ArrowButton>
                </PopHeader>
                <PopRow>
                  <span>Burned</span>
                  <span className="v">
                    {fmtBurned(hoverSeries.points[hoverSeries.points.length - 1]?.value ?? 0)} {hoverSeries.label}
                  </span>
                </PopRow>
                <PopRow>
                  <span>First burn</span>
                  <span className="v">{fmtDayLocal(hoverSeries.points[0]!.ts)}</span>
                </PopRow>
                {hoverMeta ? (
                  <PopRow>
                    <span>Pools</span>
                    <span className="v">{hoverMeta.pool_count}</span>
                  </PopRow>
                ) : null}
                {hoverMeta?.description ? <PopDesc>{hoverMeta.description}</PopDesc> : null}
              </Popover>
            ) : null}
          </Strip>
        ) : null}
      </Plot>
    </Wrap>
  );
};
