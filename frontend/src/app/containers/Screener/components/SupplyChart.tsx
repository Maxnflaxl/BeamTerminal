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
import { fmtNum } from './format';

const Wrap = styled.div`
  position: relative;
  width: 100%;
  height: 220px;
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
  color: rgba(255, 255, 255, 0.7);
  display: flex;
  gap: 6px;
  align-items: baseline;
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

    const series = chart.addLineSeries({
      color: '#00f6d2',
      lineWidth: 2,
      lineType: 2, // WithSteps — supply changes are discrete
      priceFormat: { type: 'custom', formatter: (v: number) => fmtNum(v, 0), minMove: 1 },
    });
    seriesRef.current = series;

    // Pre-build the legend nodes once; mutate via textContent on crosshair move.
    const lg = legendRef.current;
    let nodes: { lbl: HTMLSpanElement; val: HTMLSpanElement; unit: HTMLSpanElement } | null = null;
    if (lg) {
      while (lg.firstChild) lg.removeChild(lg.firstChild);
      const mk = (cls: string, txt = ''): HTMLSpanElement => {
        const s = document.createElement('span');
        s.className = cls;
        s.textContent = txt;
        return s;
      };
      const lbl = mk('lbl', 'Supply');
      const val = mk('val', '');
      const u = mk('unit', unit ?? '');
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
    const data: LineData[] = points
      .filter((p) => p.ts > 0 && Number.isFinite(p.supply))
      .map((p) => ({ time: p.ts as UTCTimestamp, value: p.supply }));
    s.setData(data);
    if (data.length > 0) chartRef.current?.timeScale().fitContent();
  }, [points]);

  return (
    <Wrap>
      <Inner ref={innerRef} />
      <Legend ref={legendRef} />
    </Wrap>
  );
};
