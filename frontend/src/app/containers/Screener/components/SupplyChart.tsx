import React, { useEffect, useRef } from 'react';
import { styled } from '@linaria/react';
import type { IChartApi, ISeriesApi, LineData, UTCTimestamp } from 'lightweight-charts';
import { fmtNum } from './format';
import { createBeamChart, CHART_COLORS, ChartWrap, ChartInner, ChartLegend, clearChildren, makeSpan } from './chartTheme';

const Legend = styled(ChartLegend)`
  display: flex;
  align-items: baseline;
  & > * + * { margin-left: 6px; }
  & .lbl { color: rgba(255,255,255,0.4); }
  & .val { color: #fff; }
  & .unit { color: rgba(255,255,255,0.4); margin-left: 4px; }
`;

interface Point {
  ts: number;
  supply: number;
}

interface Props {
  points: Point[];
  unit?: string;
}

/** Read-only step-line chart of circulating supply over time. Mint/burn events
 *  are discrete jumps, so a stepLine is more honest than a smoothed area. */
export const SupplyChart: React.FC<Props> = ({ points, unit }) => {
  const innerRef = useRef<HTMLDivElement>(null);
  const legendRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const pointsRef = useRef<Point[]>(points);
  pointsRef.current = points;

  useEffect(() => {
    const el = innerRef.current;
    if (!el) return undefined;

    const chart = createBeamChart(el, { timeScale: { rightOffset: 5 } });
    chartRef.current = chart;

    const series = chart.addLineSeries({
      color: CHART_COLORS.accent,
      lineWidth: 2,
      lineType: 2, // WithSteps — supply changes are discrete
      priceFormat: { type: 'custom', formatter: (v: number) => fmtNum(v, 0), minMove: 1 },
    });
    seriesRef.current = series;

    // Pre-build the legend nodes once; mutate via textContent on crosshair move.
    const lg = legendRef.current;
    let nodes: { lbl: HTMLSpanElement; val: HTMLSpanElement; unit: HTMLSpanElement } | null = null;
    if (lg) {
      clearChildren(lg);
      const lbl = makeSpan('lbl', 'Supply');
      const val = makeSpan('val', '');
      const u = makeSpan('unit', unit ?? '');
      lg.appendChild(lbl);
      lg.appendChild(val);
      lg.appendChild(u);
      nodes = { lbl, val, unit: u };
    }

    chart.subscribeCrosshairMove((param) => {
      if (!nodes) return;
      if (!param || !param.time) {
        nodes.val.textContent = '';
        return;
      }
      const target = param.time as UTCTimestamp;
      const p = pointsRef.current.find((pt) => (pt.ts as UTCTimestamp) === target);
      nodes.val.textContent = p ? fmtNum(p.supply, 0) : '';
    });

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [unit]);

  useEffect(() => {
    const s = seriesRef.current;
    if (!s) return;
    // lightweight-charts requires strictly-ascending, unique timestamps; supply
    // history can carry two events in the same block (same ts), so sort and
    // collapse same-ts points (last value wins) to avoid a setData assertion.
    const data: LineData[] = [];
    const sorted = points
      .filter((p) => p.ts > 0 && Number.isFinite(p.supply))
      .slice()
      .sort((a, b) => a.ts - b.ts);
    for (const p of sorted) {
      const time = p.ts as UTCTimestamp;
      const last = data[data.length - 1];
      if (last && last.time === time) last.value = p.supply;
      else data.push({ time, value: p.supply });
    }
    s.setData(data);
    if (data.length > 0) chartRef.current?.timeScale().fitContent();
  }, [points]);

  return (
    <ChartWrap h="220px">
      <ChartInner ref={innerRef} />
      <Legend ref={legendRef} />
    </ChartWrap>
  );
};
