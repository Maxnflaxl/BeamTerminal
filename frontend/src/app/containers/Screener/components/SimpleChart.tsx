import React, { useEffect, useRef } from 'react';
import { styled } from '@linaria/react';
import {
  createChart,
  ColorType,
  CrosshairMode,
  LineStyle,
  PriceScaleMode,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { ApiChartPoint } from '../api/client';

const Wrap = styled.div`
  width: 100%;
  height: 100%;
  min-height: 220px;
  position: relative;
`;

const Header = styled.div`
  position: absolute;
  top: 8px;
  left: 12px;
  z-index: 10;
  pointer-events: none;
  font-family: 'SFProDisplay', monospace;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.7);
`;

const Inner = styled.div`
  width: 100%;
  height: 100%;
  min-height: 220px;
`;

// Two-swatch legend shown when an overlay line is present (e.g. the
// Transactions / day chart's coinbase baseline). Margin-based spacing — fl/grid
// `gap` isn't supported on the wallet's QtWebEngine 5.15.2 (Chrome 83).
const Legend = styled.div`
  position: absolute;
  top: 8px;
  left: 12px;
  z-index: 10;
  pointer-events: none;
  display: flex;
  align-items: center;
  font-family: 'SFProDisplay', monospace;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.7);

  & > * + * { margin-left: 12px; }
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
}

function defaultFormatter(v: number): string {
  if (!Number.isFinite(v)) return '';
  const abs = Math.abs(v);
  if (abs >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return (v / 1e3).toFixed(2) + 'k';
  if (abs >= 1)   return v.toFixed(2);
  if (abs > 0)    return v.toPrecision(3);
  return '0';
}

export const SimpleChart: React.FC<Props> = ({ series, title, scale = 1, formatter = defaultFormatter, logScale = false, onChartReady, overlaySeries, overlayLabel, overlayColor = '#f5a623' }) => {
  const innerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Area'> | null>(null);
  const overlayRef = useRef<ISeriesApi<'Line'> | null>(null);
  // Stash the latest onChartReady in a ref so callers don't have to memoise
  // it — listing it in the create-effect's deps would rebuild the entire
  // chart whenever an inline arrow caller re-renders.
  const onChartReadyRef = useRef(onChartReady);
  useEffect(() => { onChartReadyRef.current = onChartReady; }, [onChartReady]);

  useEffect(() => {
    const el = innerRef.current;
    if (!el) return undefined;
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: '#042548' },
        textColor: 'rgba(255, 255, 255, 0.55)',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(255, 255, 255, 0.04)' },
        horzLines: { color: 'rgba(255, 255, 255, 0.04)' },
      },
      crosshair: {
        mode: CrosshairMode.Magnet,
        vertLine: { color: 'rgba(0, 246, 210, 0.4)', width: 1, style: 0, labelBackgroundColor: '#00f6d2' },
        horzLine: { color: 'rgba(0, 246, 210, 0.4)', width: 1, style: 0, labelBackgroundColor: '#00f6d2' },
      },
      rightPriceScale: { borderColor: 'rgba(255, 255, 255, 0.1)' },
      timeScale: {
        borderColor: 'rgba(255, 255, 255, 0.1)',
        timeVisible: false,
        secondsVisible: false,
        minBarSpacing: 0.01,
      },
    });
    chartRef.current = chart;
    seriesRef.current = chart.addAreaSeries({
      lineColor: '#00f6d2',
      topColor: 'rgba(0, 246, 210, 0.28)',
      bottomColor: 'rgba(0, 246, 210, 0.02)',
      lineWidth: 2,
      priceFormat: { type: 'custom', formatter, minMove: 0.000001 },
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

  useEffect(() => {
    const s = seriesRef.current;
    if (!s) return;
    const data: LineData[] = series.map((p) => ({
      time: p.ts as UTCTimestamp,
      value: p.value * scale,
    }));
    s.setData(data);
    if (data.length > 0) chartRef.current?.timeScale().fitContent();
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
        });
      }
      overlayRef.current.setData(
        overlaySeries.map((p) => ({ time: p.ts as UTCTimestamp, value: p.value * scale })),
      );
    } else if (overlayRef.current) {
      chart.removeSeries(overlayRef.current);
      overlayRef.current = null;
    }
  }, [overlaySeries, scale, overlayColor]);

  return (
    <Wrap>
      {overlaySeries && overlayLabel ? (
        <Legend>
          <LegendItem>
            <i style={{ borderTopColor: '#00f6d2', borderTopStyle: 'solid' }} />
            {title || 'Total'}
          </LegendItem>
          <LegendItem>
            <i style={{ borderTopColor: overlayColor, borderTopStyle: 'dashed' }} />
            {overlayLabel}
          </LegendItem>
        </Legend>
      ) : (
        title ? <Header>{title}</Header> : null
      )}
      <Inner ref={innerRef} />
    </Wrap>
  );
};
