import React, {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { styled } from '@linaria/react';
import {
  LineStyle,
  PriceScaleMode,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type UTCTimestamp,
} from 'lightweight-charts';
import AssetIcon, { normalizeOptColor } from '@app/shared/components/AssetsIcon';
import { PALLETE_ASSETS } from '@app/shared/constants';
import { createBeamChart } from './chartTheme';
import type { ApiBlackholeSeries } from '../api/client';
import type { ApiAssetListEntry } from '../api/types';
import { useAssets } from '../hooks';

// Colour per asset — the asset's brand colour (OPT_COLOR) when known, otherwise
// the same per-aid palette slot AssetIcon falls back to, so the line, its legend
// swatch, and the asset icon all share one colour. Exported so the SVG/PNG
// export agrees with the on-screen chart.
export function buildBlackholeColors(
  series: ReadonlyArray<ApiBlackholeSeries>,
): Map<number, string> {
  const map = new Map<number, string>();
  for (const s of series) {
    const color = normalizeOptColor(s.color)
      ?? PALLETE_ASSETS[s.aid] ?? PALLETE_ASSETS[s.aid % PALLETE_ASSETS.length]!;
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
export function buildBlackholeLineStyles(
  series: ReadonlyArray<ApiBlackholeSeries>,
): Map<number, BlackholeLineStyle> {
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
  solid: 'solid', dashed: 'dashed', dotted: 'dotted', 'large-dashed': 'dashed',
};
// SVG stroke-dasharray for the PNG/SVG export ('' = solid).
export const LINE_STYLE_DASH: Record<BlackholeLineStyle, string> = {
  solid: '', dashed: '6 4', dotted: '2 3', 'large-dashed': '10 5',
};

const ICON_PX = 20;

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
  font-family: 'SFProDisplay', monospace;
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

  &:hover { color: #00f6d2; }
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

  &:hover,
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
  font-family: 'SFProDisplay', monospace;
  font-size: 12px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.55);
  pointer-events: auto;
`;

const PopHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
  & > * + * { margin-left: 8px; }
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
  & > .icon > * { margin: 0 !important; }
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
  & + & { margin-top: 2px; }

  & > .v { color: rgba(255, 255, 255, 0.92); margin-left: 8px; }
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
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <line x1="2" y1="6" x2="10" y2="6" />
    <polyline points="6 2 10 6 6 10" />
  </svg>
);

// Local-time YYYY-MM-DD (toISOString would drift a day for users far from UTC).
function formatDate(ts: number): string {
  const d = new Date(ts * 1000);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

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

function defaultFormatter(v: number): string {
  if (!Number.isFinite(v)) return '';
  const abs = Math.abs(v);
  if (abs >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return (v / 1e3).toFixed(2) + 'k';
  if (abs >= 1) return v.toFixed(2);
  if (abs > 0) return v.toPrecision(3);
  return '0';
}

export const BlackholeChart: React.FC<Props> = ({ series, logScale = false, formatter = defaultFormatter, showMarkers = false }) => {
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
  const navigate = useNavigate();

  const { data: assetsData } = useAssets();
  const metaByAid = useMemo(() => {
    const map = new Map<number, ApiAssetListEntry>();
    if (assetsData) for (const a of assetsData.assets) map.set(a.aid, a);
    return map;
  }, [assetsData]);

  // Stable colour + line style per asset (series order is stable per load).
  const colorByAid = useMemo(() => buildBlackholeColors(series), [series]);
  const styleByAid = useMemo(() => buildBlackholeLineStyles(series), [series]);

  // Full price extent across the *visible* series (recomputed only when the
  // data or legend selection changes — never on pan). Padded slightly in log
  // space so the top/bottom lines aren't flush against the frame.
  const priceRange = useMemo(() => {
    let min = Infinity;
    let max = -Infinity;
    for (const s of series) {
      if (hidden.has(s.aid)) continue;
      for (const p of s.points) {
        if (p.value > 0) { if (p.value < min) min = p.value; if (p.value > max) max = p.value; }
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
        if (written.get(s.aid) !== 'hidden') { el.style.display = 'none'; written.set(s.aid, 'hidden'); }
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
  useEffect(() => { updatePositionsRef.current = updatePositions; }, [updatePositions]);

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
    if (!chart) return;
    for (const s of seriesRef.current.values()) chart.removeSeries(s);
    seriesRef.current.clear();
    for (const s of series) {
      const line = chart.addLineSeries({
        color: colorByAid.get(s.aid),
        lineWidth: 2,
        lineStyle: LINE_STYLE_ENUM[styleByAid.get(s.aid) ?? 'solid'],
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
      const data: LineData[] = s.points.map((p) => ({ time: p.ts as UTCTimestamp, value: p.value }));
      line.setData(data);
      seriesRef.current.set(s.aid, line);
    }
    if (series.length > 0) chart.timeScale().fitContent();
    // The rAF reposition loop re-places the icons once the new scale settles.
    // `hidden` is intentionally omitted — visibility is applied by the effect
    // below so toggling a legend item doesn't rebuild every series.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, colorByAid, styleByAid, formatter]);

  useEffect(() => {
    for (const [aid, line] of seriesRef.current) {
      line.applyOptions({ visible: !hidden.has(aid) });
    }
    // The rAF loop hides/shows the corresponding markers next frame.
  }, [hidden]);

  useEffect(() => () => {
    if (hoverTimer.current != null) window.clearTimeout(hoverTimer.current);
  }, []);

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
            title={hidden.has(s.aid) ? `Show ${s.label}` : `Hide ${s.label}`}
          >
            <i style={{ borderTopColor: colorByAid.get(s.aid), borderTopStyle: LINE_STYLE_CSS[styleByAid.get(s.aid) ?? 'solid'] }} />
            {s.label}
            <span className="aid">#{s.aid}</span>
          </LegendItem>
        ))}
      </Legend>
      <Plot>
        <Inner ref={innerRef} />
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
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(s.aid); }
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
              style={hoverRight
                ? { left: `${hoverPos.x + 12}px`, top: `${hoverPos.y}px`, transform: 'translateY(-50%)' }
                : { left: `${Math.max(4, hoverPos.x - 12)}px`, top: `${hoverPos.y}px`, transform: 'translate(-100%, -50%)' }}
              onMouseEnter={() => openHover(hoverAid)}
              onMouseLeave={closeHoverSoon}
            >
              <PopHeader>
                <PopTitle>
                  <span className="icon">
                    <AssetIcon asset_id={hoverAid} color={hoverSeries.color ?? hoverMeta?.color ?? null} logoUrl={hoverMeta?.logo_url ?? null} size={22} />
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
                <ArrowButton type="button" onClick={() => go(hoverAid)} title="Open asset details" aria-label="Open asset details">
                  <ArrowIcon />
                </ArrowButton>
              </PopHeader>
              <PopRow>
                <span>Burned</span>
                <span className="v">{fmtBurned(hoverSeries.points[hoverSeries.points.length - 1]?.value ?? 0)} {hoverSeries.label}</span>
              </PopRow>
              <PopRow>
                <span>First burn</span>
                <span className="v">{formatDate(hoverSeries.points[0]!.ts)}</span>
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
