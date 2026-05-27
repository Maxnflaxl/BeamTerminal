import React, { useEffect, useRef } from 'react';
import { styled } from '@linaria/react';
import {
  createChart,
  ColorType,
  CrosshairMode,
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

interface Props {
  series: ReadonlyArray<ApiChartPoint>;
  title: string;
  /** Optional per-value pre-conversion (e.g. raw hashes/s → MSol/s). */
  scale?: number;
  /** Tooltip / axis formatter (number → display string). */
  formatter?: (v: number) => string;
  /** Render the price axis on a base-10 log scale. */
  logScale?: boolean;
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

export const SimpleChart: React.FC<Props> = ({ series, title, scale = 1, formatter = defaultFormatter, logScale = false }) => {
  const innerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Area'> | null>(null);

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
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
    // Formatter is only honoured at construction time — re-create on change.
    // logScale is applied via the dedicated effect below so we don't lose
    // the data on every toggle.
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

  return (
    <Wrap>
      {title ? <Header>{title}</Header> : null}
      <Inner ref={innerRef} />
    </Wrap>
  );
};
