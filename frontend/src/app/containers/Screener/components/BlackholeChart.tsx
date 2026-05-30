import React, { useEffect, useMemo, useRef, useState } from 'react';
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
import type { ApiBlackholeSeries } from '../api/client';

// Fallback palette for assets without an OPT_COLOR brand colour. Picked for
// contrast against the #042548 plot background and each other.
const PALETTE = [
  '#00f6d2', '#f5a623', '#ff6b6b', '#9b8cff', '#4dd2ff', '#ffd93d',
  '#7bed9f', '#ff9ff3', '#54a0ff', '#feca57', '#5f27cd', '#1dd1a1',
  '#ff6348', '#48dbfb', '#c8d6e5',
];

// Stable colour per asset: brand colour when known, else a palette slot
// assigned by position. Exported so the chart and its SVG/PNG export agree.
export function buildBlackholeColors(
  series: ReadonlyArray<ApiBlackholeSeries>,
): Map<number, string> {
  const map = new Map<number, string>();
  let next = 0;
  for (const s of series) map.set(s.aid, s.color ?? PALETTE[next++ % PALETTE.length]!);
  return map;
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

const Inner = styled.div`
  flex: 1 1 auto;
  min-height: 0;
  width: 100%;
`;

interface Props {
  series: ReadonlyArray<ApiBlackholeSeries>;
  logScale?: boolean;
  formatter?: (v: number) => string;
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

export const BlackholeChart: React.FC<Props> = ({ series, logScale = false, formatter = defaultFormatter }) => {
  const innerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<Map<number, ISeriesApi<'Line'>>>(new Map());
  // Hidden asset ids (legend toggles). aid → omitted from the plot.
  const [hidden, setHidden] = useState<Set<number>>(new Set());

  // Stable colour per asset (series order is stable per load).
  const colorByAid = useMemo(() => buildBlackholeColors(series), [series]);

  // Re-create the chart only when the formatter changes (it's applied at
  // construction time). logScale / data / visibility are handled by the
  // dedicated effects below so toggling them doesn't drop the data.
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
        mode: CrosshairMode.Normal,
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
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current.clear();
    };
  }, [formatter]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.priceScale('right').applyOptions({
      mode: logScale ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal,
    });
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
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: true,
        visible: !hidden.has(s.aid),
        priceFormat: { type: 'custom', formatter, minMove: 0.00000001 },
      });
      const data: LineData[] = s.points.map((p) => ({ time: p.ts as UTCTimestamp, value: p.value }));
      line.setData(data);
      seriesRef.current.set(s.aid, line);
    }
    if (series.length > 0) chart.timeScale().fitContent();
    // `hidden` is intentionally omitted — visibility is applied by the effect
    // below so toggling a legend item doesn't rebuild every series.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, colorByAid, formatter]);

  useEffect(() => {
    for (const [aid, line] of seriesRef.current) {
      line.applyOptions({ visible: !hidden.has(aid) });
    }
  }, [hidden]);

  const toggle = (aid: number): void => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(aid)) next.delete(aid);
      else next.add(aid);
      return next;
    });
  };

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
            <i style={{ borderTopColor: colorByAid.get(s.aid) }} />
            {s.label}
            <span className="aid">#{s.aid}</span>
          </LegendItem>
        ))}
      </Legend>
      <Inner ref={innerRef} />
    </Wrap>
  );
};
