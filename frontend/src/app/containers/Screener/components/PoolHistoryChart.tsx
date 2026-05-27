import React, { useEffect, useRef } from 'react';
import { styled } from '@linaria/react';
import {
  createChart,
  ColorType,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { ApiPoolLiquidityPoint } from '../api/types';
import { fmtNum } from './format';

const Wrap = styled.div`
  position: relative;
  width: 100%;
  height: 320px;
`;

const Inner = styled.div`
  width: 100%;
  height: 100%;
`;

const Legend = styled.div`
  position: absolute;
  top: 8px;
  left: 12px;
  z-index: 10;
  pointer-events: none;
  font-family: 'SFProDisplay', monospace;
  font-size: 12px;
  display: flex;
  gap: 14px;
  align-items: baseline;
  .item { display: flex; gap: 5px; align-items: baseline; }
  .swatch { width: 9px; height: 9px; border-radius: 2px; align-self: center; }
  .lbl { color: rgba(255, 255, 255, 0.5); }
  .val { color: #fff; }
`;

// sym1 (aid1, e.g. BEAM) teal; sym2 (aid2) white — matches BeamAssets' Pooled
// BEAM / Pooled BEAMX colouring.
const COLOR1 = '#00f6d2';
const COLOR2 = '#ffffff';

export type SeriesVisibility = 'both' | '1' | '2';

interface Props {
  series: ApiPoolLiquidityPoint[];
  decimals1: number;
  decimals2: number;
  sym1: string;
  sym2: string;
  visible: SeriesVisibility;
  /** Unix-seconds date to center the view on (null = leave as-is). */
  centerOn?: number | null;
}

/** Two-line history of pooled amounts (aid1 + aid2) over time. Modeled on the
 *  asset SupplyChart but with a second series and a dual-value legend. */
export const PoolHistoryChart: React.FC<Props> = ({
  series, decimals1, decimals2, sym1, sym2, visible, centerOn,
}) => {
  const innerRef = useRef<HTMLDivElement>(null);
  const legendRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const s1Ref = useRef<ISeriesApi<'Line'> | null>(null);
  const s2Ref = useRef<ISeriesApi<'Line'> | null>(null);
  // Keep latest derived points for the crosshair legend without re-creating the chart.
  const dataRef = useRef<{ d1: LineData[]; d2: LineData[] }>({ d1: [], d2: [] });

  // Build once.
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
        vertLine: { color: 'rgba(0, 246, 210, 0.4)', width: 1, style: LineStyle.Solid, labelBackgroundColor: '#00f6d2' },
        horzLine: { color: 'rgba(0, 246, 210, 0.4)', width: 1, style: LineStyle.Solid, labelBackgroundColor: '#00f6d2' },
      },
      rightPriceScale: { borderColor: 'rgba(255, 255, 255, 0.1)' },
      timeScale: { borderColor: 'rgba(255, 255, 255, 0.1)', timeVisible: false, secondsVisible: false, rightOffset: 5 },
    });
    chartRef.current = chart;

    s1Ref.current = chart.addLineSeries({
      color: COLOR1,
      lineWidth: 2,
      priceFormat: { type: 'custom', formatter: (v: number) => fmtNum(v, 0), minMove: 1 },
    });
    s2Ref.current = chart.addLineSeries({
      color: COLOR2,
      lineWidth: 2,
      priceFormat: { type: 'custom', formatter: (v: number) => fmtNum(v, 0), minMove: 1 },
    });

    // Legend: two coloured items, value filled on crosshair move.
    const lg = legendRef.current;
    let nodes: { v1: HTMLSpanElement; v2: HTMLSpanElement } | null = null;
    if (lg) {
      while (lg.firstChild) lg.removeChild(lg.firstChild);
      const mkItem = (color: string, label: string): { item: HTMLDivElement; val: HTMLSpanElement } => {
        const item = document.createElement('div');
        item.className = 'item';
        const sw = document.createElement('span');
        sw.className = 'swatch';
        sw.style.background = color;
        const lbl = document.createElement('span');
        lbl.className = 'lbl';
        lbl.textContent = label;
        const val = document.createElement('span');
        val.className = 'val';
        item.appendChild(sw);
        item.appendChild(lbl);
        item.appendChild(val);
        return { item, val };
      };
      const i1 = mkItem(COLOR1, `Pooled ${sym1}`);
      const i2 = mkItem(COLOR2, `Pooled ${sym2}`);
      lg.appendChild(i1.item);
      lg.appendChild(i2.item);
      nodes = { v1: i1.val, v2: i2.val };
    }

    chart.subscribeCrosshairMove((param) => {
      if (!nodes) return;
      if (!param || !param.time) { nodes.v1.textContent = ''; nodes.v2.textContent = ''; return; }
      const t = param.time as UTCTimestamp;
      const p1 = dataRef.current.d1.find((p) => p.time === t);
      const p2 = dataRef.current.d2.find((p) => p.time === t);
      nodes.v1.textContent = p1 ? fmtNum(p1.value, 0) : '';
      nodes.v2.textContent = p2 ? fmtNum(p2.value, 0) : '';
    });

    return () => {
      chart.remove();
      chartRef.current = null;
      s1Ref.current = null;
      s2Ref.current = null;
    };
    // sym labels are baked into the legend on construction.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sym1, sym2]);

  // Push data on change.
  useEffect(() => {
    const s1 = s1Ref.current;
    const s2 = s2Ref.current;
    if (!s1 || !s2) return;
    const div1 = 10 ** decimals1;
    const div2 = 10 ** decimals2;
    const d1: LineData[] = series.map((p) => ({ time: p.ts as UTCTimestamp, value: Number(p.amount1) / div1 }));
    const d2: LineData[] = series.map((p) => ({ time: p.ts as UTCTimestamp, value: Number(p.amount2) / div2 }));
    dataRef.current = { d1, d2 };
    s1.setData(visible === '2' ? [] : d1);
    s2.setData(visible === '1' ? [] : d2);
    // Each data load is a deliberate timeframe/source switch (the hook doesn't
    // poll), so refit to the new window. A subsequent centerOn overrides this.
    if (series.length > 0) chartRef.current?.timeScale().fitContent();
  }, [series, decimals1, decimals2, visible]);

  // Center on a chosen date (±30 buckets, derived from average spacing).
  useEffect(() => {
    if (centerOn == null) return;
    const chart = chartRef.current;
    if (!chart || series.length === 0) return;
    const span = series.length >= 2
      ? Math.max(1, (series[series.length - 1]!.ts - series[0]!.ts) / (series.length - 1))
      : 86400;
    const half = span * 30;
    try {
      chart.timeScale().setVisibleRange({
        from: (centerOn - half) as UTCTimestamp,
        to: (centerOn + half) as UTCTimestamp,
      });
    } catch { /* out of range */ }
  }, [centerOn, series]);

  return (
    <Wrap>
      <Inner ref={innerRef} />
      <Legend ref={legendRef} />
    </Wrap>
  );
};
