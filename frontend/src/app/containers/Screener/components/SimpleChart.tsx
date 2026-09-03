import React, { useEffect, useRef } from 'react';
import { styled } from '@linaria/react';
import {
  CrosshairMode,
  LineStyle,
  PriceScaleMode,
  type AutoscaleInfo,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { ApiChartPoint } from '../api/client';
import { createBeamChart, CHART_COLORS, ChartWrap, ChartInner, ChartLegend } from './chartTheme';

// Two-swatch legend shown when an overlay line is present (e.g. the
// Transactions / day chart's coinbase baseline). Margin-based spacing — fl/grid
// `gap` isn't supported on the wallet's QtWebEngine 5.15.2 (Chrome 83).
const Legend = styled(ChartLegend)`
  display: flex;
  align-items: center;
  & > * + * {
    margin-left: 12px;
  }
`;

const LegendItem = styled.span`
  display: inline-flex;
  align-items: center;

  & > i {
    display: inline-block;
    width: 14px;
    height: 0;
    margin-right: 5px;
    border-top-width: 2px;
  }
`;

interface Props {
  series: ReadonlyArray<ApiChartPoint>;
  title: string;
  /** Optional per-value pre-conversion (e.g. raw hashes/s → MSol/s). */
  scale?: number;
  /** Tooltip / axis formatter (number → display string). */
  formatter?: (v: number) => string;
  /** Render the price axis on a base-10 log scale. */
  logScale?: boolean;
  /** Called after the chart is created so a parent can position overlays
   *  relative to the time scale. Returns a teardown to run before re-create. */
  onChartReady?: (chart: IChartApi, container: HTMLDivElement) => (() => void) | void;
  /** Optional comparison line drawn on the same right axis (e.g. a baseline).
   *  When present, a dashed second series is rendered and a legend is shown. */
  overlaySeries?: ReadonlyArray<ApiChartPoint>;
  /** Legend label for the overlay line. */
  overlayLabel?: string;
  /** Overlay line colour. Defaults to a muted amber. */
  overlayColor?: string;
  /** Free wheel-zoom and drag-pan, and a time-of-day axis. Every new series is
   *  still fitted to the plot: the data only changes when a toolbar button
   *  picks a new window or bucket, and that is a new view. */
  interactive?: boolean;
}

// lightweight-charts asserts on non-ascending or duplicate timestamps. Per-block
// explorer data (dh=1) can carry two points in the same second, so sort by time
// and collapse duplicates (keeping the last value) before handing it to setData.
//
// Points at or before the epoch are dropped rather than plotted. No series here
// legitimately starts in 1970, and a single such point stretches the time axis
// across five decades of emptiness — squeezing the real data into the last few
// pixels — so one bad row upstream would otherwise take every chart carrying it
// with it.
function toLineData(series: ReadonlyArray<ApiChartPoint>, scale: number): LineData[] {
  const mapped = series
    .filter((p) => Number.isFinite(p.ts) && p.ts > 0)
    .map((p) => ({ time: p.ts as UTCTimestamp, value: p.value * scale }));
  mapped.sort((a, b) => (a.time as number) - (b.time as number));
  const out: LineData[] = [];
  for (const pt of mapped) {
    const n = out.length;
    if (n > 0 && out[n - 1].time === pt.time) out[n - 1] = pt;
    else out.push(pt);
  }
  return out;
}

// lightweight-charts pads the auto-scaled range below the data minimum, which
// shows negative axis labels even when every value is >= 0 (counts, totals,
// hashrate, prices…). When the data is non-negative, floor the visible range at
// 0 (with a little symmetric headroom); genuine negative data is left untouched.
function nonNegAutoscale(base: () => AutoscaleInfo | null, nonNeg: boolean): AutoscaleInfo | null {
  const info = base();
  if (!info || !nonNeg || info.priceRange.minValue < 0) return info;
  const { minValue, maxValue } = info.priceRange;
  const pad = (maxValue - minValue) * 0.05 || Math.abs(maxValue) * 0.05 || 1;
  return {
    priceRange: { minValue: Math.max(0, minValue - pad), maxValue: maxValue + pad },
    margins: { above: 0, below: 0 },
  };
}

function allNonNegative(data: ReadonlyArray<{ value: number }>): boolean {
  for (const d of data) if (d.value < 0) return false;
  return true;
}

function defaultFormatter(v: number): string {
  if (!Number.isFinite(v)) return '';
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(2)}k`;
  if (abs >= 1) return v.toFixed(2);
  if (abs > 0) return v.toPrecision(3);
  return '0';
}

export const SimpleChart: React.FC<Props> = ({
  series,
  title,
  scale = 1,
  formatter = defaultFormatter,
  logScale = false,
  onChartReady,
  overlaySeries,
  overlayLabel,
  overlayColor = '#f5a623',
  interactive = false,
}) => {
  const innerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Area'> | null>(null);
  const overlayRef = useRef<ISeriesApi<'Line'> | null>(null);
  // Stash the latest onChartReady in a ref so callers don't have to memoise
  // it — listing it in the create-effect's deps would rebuild the entire
  // chart whenever an inline arrow caller re-renders.
  const onChartReadyRef = useRef(onChartReady);
  useEffect(() => {
    onChartReadyRef.current = onChartReady;
  }, [onChartReady]);

  // Whether the current main / overlay data is all >= 0 (read by the series'
  // autoscaleInfoProvider to floor the axis at 0 — see nonNegAutoscale).
  const nonNegRef = useRef(true);
  const overlayNonNegRef = useRef(true);

  useEffect(() => {
    const el = innerRef.current;
    if (!el) return undefined;
    // Magnet crosshair (snaps to the series) — unique to this chart.
    const chart = createBeamChart(el, {
      crosshair: { mode: CrosshairMode.Magnet },
      // No bottom margin — the axis floor comes from the series autoscale
      // (nonNegAutoscale), which never dips below 0 for non-negative data. Top
      // headroom keeps the latest-value label from clipping.
      rightPriceScale: { scaleMargins: { top: 0.1, bottom: 0 } },
      timeScale: {
        minBarSpacing: 0.01,
        // Interactive (expanded) chart: show the time of day. Edges are left
        // free (no fixLeftEdge/fixRightEdge) so any point — including the
        // latest — can be panned to the centre of the view.
        ...(interactive ? { timeVisible: true, secondsVisible: false } : {}),
      },
      // Grid cells are static previews (no free pan/zoom). The expanded chart is
      // interactive: native wheel/drag zoom is on.
      ...(interactive ? {} : { handleScroll: false, handleScale: false }),
    });
    chartRef.current = chart;
    seriesRef.current = chart.addAreaSeries({
      lineColor: CHART_COLORS.accent,
      topColor: 'rgba(0, 246, 210, 0.28)',
      bottomColor: 'rgba(0, 246, 210, 0.02)',
      lineWidth: 2,
      priceFormat: { type: 'custom', formatter, minMove: 0.000001 },
      autoscaleInfoProvider: (base: () => AutoscaleInfo | null) => nonNegAutoscale(base, nonNegRef.current),
    });
    const teardown = onChartReadyRef.current?.(chart, el);
    return () => {
      if (typeof teardown === 'function') teardown();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      overlayRef.current = null;
    };
    // Formatter is only honoured at construction time — re-create on change.
    // logScale is applied via the dedicated effect below so we don't lose
    // the data on every toggle. onChartReady is read through a ref so a
    // caller passing a fresh callback identity doesn't trigger a rebuild.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formatter]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.priceScale('right').applyOptions({
      mode: logScale ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal,
    });
  }, [logScale]);

  // NOTE: this MUST be a passive `useEffect`, not `useLayoutEffect`. The chart +
  // series are created in the passive create-effect above; a layout effect here
  // would run (in the layout phase) BEFORE that create-effect on mount, find
  // `seriesRef.current` null, bail, and never call `setData` — leaving every
  // chart blank until `series` next changes (which never happens for the static
  // grid charts). Passive phase runs effects in declaration order, so this runs
  // after the create-effect. The one-frame settle is acceptable; a blank grid
  // is not.
  useEffect(() => {
    const s = seriesRef.current;
    const chart = chartRef.current;
    if (!s || !chart) return;
    const data: LineData[] = toLineData(series, scale);
    nonNegRef.current = allNonNegative(data); // floor the axis at 0 when all >= 0
    s.setData(data);
    if (data.length > 0) chart.timeScale().fitContent();
  }, [series, scale]);

  // Optional overlay comparison line — created lazily on the same right axis,
  // updated on data/scale change, and removed if the prop clears. Mirrors the
  // logScale/data effects' chartRef access pattern.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    if (overlaySeries && overlaySeries.length > 0) {
      if (!overlayRef.current) {
        overlayRef.current = chart.addLineSeries({
          color: overlayColor,
          lineWidth: 2,
          lineStyle: LineStyle.Dashed,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
          autoscaleInfoProvider: (base: () => AutoscaleInfo | null) => nonNegAutoscale(base, overlayNonNegRef.current),
        });
      }
      const overlayData = toLineData(overlaySeries, scale);
      overlayNonNegRef.current = allNonNegative(overlayData);
      overlayRef.current.setData(overlayData);
    } else if (overlayRef.current) {
      chart.removeSeries(overlayRef.current);
      overlayRef.current = null;
    }
  }, [overlaySeries, scale, overlayColor]);

  return (
    <ChartWrap minH="220px">
      {overlaySeries && overlayLabel ? (
        <Legend>
          <LegendItem>
            <i style={{ borderTopColor: CHART_COLORS.accent, borderTopStyle: 'solid' }} />
            {title || 'Total'}
          </LegendItem>
          <LegendItem>
            <i style={{ borderTopColor: overlayColor, borderTopStyle: 'dashed' }} />
            {overlayLabel}
          </LegendItem>
        </Legend>
      ) : title ? (
        <ChartLegend>{title}</ChartLegend>
      ) : null}
      <ChartInner ref={innerRef} />
    </ChartWrap>
  );
};
