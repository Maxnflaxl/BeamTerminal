import React, { useEffect, useRef } from 'react';
import { styled } from '@linaria/react';
import {
  createChart,
  ColorType,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type CandlestickData,
  type HistogramData,
  type LineData,
  type LogicalRange,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { ApiCandle } from '../api/types';
import { fmtPriceSub, fmtNum } from './format';

const Wrap = styled.div`
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 360px;
`;

const Inner = styled.div`
  width: 100%;
  height: 100%;
  min-height: 360px;
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
  gap: 10px;
  align-items: center;
  & .lbl { color: rgba(255,255,255,0.4); }
  & .val { color: #fff; margin-left: 2px; }
  & .chg.up   { color: #00f6d2; }
  & .chg.down { color: #f25f5b; }
  & .denom { color: rgba(255,255,255,0.4); margin-left: 4px; }
`;

interface Props {
  candles: ApiCandle[];
  style: 'candle' | 'area';
  denomSymbol: string;
  /** Volume is reported in groths of aid1; divide by 10**volumeDecimals for display. */
  volumeDecimals: number;
  volumeSymbol: string;
  /** Called when the visible range nears the left edge of loaded data. */
  onReachStart?: () => void;
  /**
   * Optional live trade overlay. When the user types an amount into the swap
   * panel we draw a single horizontal line at the *effective* rate of the
   * simulated trade, labelled with the price-impact %. The value is in the
   * same units as the chart's Y axis (aid2 per aid1). Pass `null` to clear.
   */
  tradePreview?: {
    effectiveRate: number;
    impactPct: number;
    label: string;
  } | null;
}

export const Chart: React.FC<Props> = ({
  candles, style, denomSymbol, volumeDecimals, volumeSymbol, onReachStart, tradePreview,
}) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | ISeriesApi<'Area'> | null>(null);
  const volSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const volumeDecimalsRef = useRef<number>(volumeDecimals);
  volumeDecimalsRef.current = volumeDecimals;
  const legendRef = useRef<HTMLDivElement>(null);
  // Crosshair callback needs the latest candles, but lives in the [style] effect.
  // Stash via ref so we don't capture stale data each refresh.
  const candlesRef = useRef<ApiCandle[]>(candles);
  candlesRef.current = candles;
  // `onReachStart` should also stay fresh without re-creating the chart.
  const onReachStartRef = useRef<(() => void) | undefined>(onReachStart);
  onReachStartRef.current = onReachStart;
  // First-time data load should `fitContent`; subsequent updates (appends,
  // pagination, polling) must NOT, or the user's pan/zoom gets stomped.
  const didFitRef = useRef(false);
  // Mutable handle to the effective-rate preview line so we can update it
  // in place rather than ripping+rebuilding on every keystroke.
  const previewEffRef = useRef<IPriceLine | null>(null);

  // Build / rebuild the chart whenever the rendering style changes.
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
      rightPriceScale: {
        borderColor: 'rgba(255, 255, 255, 0.1)',
        // Reserve the bottom ~22% for the volume histogram overlay.
        scaleMargins: { top: 0.08, bottom: 0.24 },
      },
      timeScale: {
        borderColor: 'rgba(255, 255, 255, 0.1)',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 5,
      },
    });

    chartRef.current = chart;

    if (style === 'candle') {
      seriesRef.current = chart.addCandlestickSeries({
        upColor: '#00f6d2',
        downColor: '#f25f5b',
        borderUpColor: '#00f6d2',
        borderDownColor: '#f25f5b',
        wickUpColor: '#00f6d2',
        wickDownColor: '#f25f5b',
        priceFormat: { type: 'custom', formatter: (p: number) => fmtPriceSub(p), minMove: 0.00000001 },
      });
    } else {
      seriesRef.current = chart.addAreaSeries({
        lineColor: '#00f6d2',
        topColor: 'rgba(0, 246, 210, 0.28)',
        bottomColor: 'rgba(0, 246, 210, 0.02)',
        lineWidth: 2,
        priceFormat: { type: 'custom', formatter: (p: number) => fmtPriceSub(p), minMove: 0.00000001 },
      });
    }

    // Volume histogram overlay — own price scale pinned to the bottom strip.
    volSeriesRef.current = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'vol',
      color: 'rgba(0, 246, 210, 0.5)',
    });
    chart.priceScale('vol').applyOptions({
      scaleMargins: { top: 0.78, bottom: 0 },
    });

    // Pre-build legend DOM once; mutate via textContent on crosshair move.
    const lg = legendRef.current;
    let nodes: { [k: string]: HTMLSpanElement } | null = null;
    if (lg) {
      // `Element.replaceChildren()` requires Chrome 86+ — the desktop wallet's
      // QtWebEngine is older. Clear children the long way.
      while (lg.firstChild) lg.removeChild(lg.firstChild);
      const make = (cls: string, txt = ''): HTMLSpanElement => {
        const s = document.createElement('span');
        s.className = cls;
        s.textContent = txt;
        return s;
      };
      const row = document.createElement('div');
      const labels: Array<['lbl' | 'val', string]> = [
        ['lbl', 'O '], ['val', ''], ['lbl', ' H '], ['val', ''],
        ['lbl', ' L '], ['val', ''], ['lbl', ' C '], ['val', ''],
      ];
      const refs: HTMLSpanElement[] = [];
      for (const [cls, txt] of labels) {
        const node = make(cls, txt);
        row.appendChild(node);
        refs.push(node);
      }
      const chg = make('chg', '');
      const denom = make('denom', denomSymbol);
      row.appendChild(document.createTextNode(' '));
      row.appendChild(chg);
      row.appendChild(document.createTextNode(' '));
      row.appendChild(denom);
      const volLbl = make('lbl', '  V ');
      const vol = make('val', '');
      const volSym = make('denom', volumeSymbol);
      row.appendChild(volLbl);
      row.appendChild(vol);
      row.appendChild(document.createTextNode(' '));
      row.appendChild(volSym);
      lg.appendChild(row);
      nodes = {
        oLbl: refs[0]!, o: refs[1]!,
        hLbl: refs[2]!, h: refs[3]!,
        lLbl: refs[4]!, l: refs[5]!,
        cLbl: refs[6]!, c: refs[7]!,
        chg, denom, vol, volSym,
      };
    }

    chart.subscribeCrosshairMove((param) => {
      if (!nodes) return;
      if (!param || !param.time) {
        nodes.o.textContent = '';
        nodes.h.textContent = '';
        nodes.l.textContent = '';
        nodes.c.textContent = '';
        nodes.chg.textContent = '';
        nodes.chg.className = 'chg';
        nodes.vol.textContent = '';
        return;
      }
      const c = candlesRef.current.find((cd) => (cd.time as UTCTimestamp) === param.time);
      if (!c) return;
      const change = c.open > 0 ? ((c.close - c.open) / c.open) * 100 : 0;
      const sign = change >= 0 ? '+' : '';
      nodes.o.textContent = fmtPriceSub(c.open);
      nodes.h.textContent = fmtPriceSub(c.high);
      nodes.l.textContent = fmtPriceSub(c.low);
      nodes.c.textContent = fmtPriceSub(c.close);
      nodes.chg.textContent = `${sign}${change.toFixed(2)}%`;
      nodes.chg.className = `chg ${change >= 0 ? 'up' : 'down'}`;
      // Volume groths of aid1 → display units. BigInt avoids overflow.
      const volNum = Number(BigInt(c.volume)) / 10 ** volumeDecimalsRef.current;
      nodes.vol.textContent = fmtNum(volNum);
    });

    // Fire `onReachStart` when the user pans/zooms within ~10 bars of the
    // leftmost loaded candle. Debounce-ish via the `pending` flag — the
    // parent hook still owns request deduping.
    chart.timeScale().subscribeVisibleLogicalRangeChange((range: LogicalRange | null) => {
      if (!range) return;
      const cb = onReachStartRef.current;
      if (!cb) return;
      if (range.from < 10) cb();
    });

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      volSeriesRef.current = null;
      didFitRef.current = false;
    };
    // `denomSymbol` / `volumeSymbol` are baked into the legend on construction;
    // rebuild when they change (a fresh fetch is already in flight, so no UX regression).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [style, denomSymbol, volumeSymbol]);

  // Push data into the series whenever candles change.
  useEffect(() => {
    const s = seriesRef.current;
    if (!s) return;
    if (style === 'candle') {
      const data: CandlestickData[] = candles.map((c) => ({
        time: c.time as UTCTimestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      }));
      (s as ISeriesApi<'Candlestick'>).setData(data);
    } else {
      const data: LineData[] = candles.map((c) => ({
        time: c.time as UTCTimestamp,
        value: c.close,
      }));
      (s as ISeriesApi<'Area'>).setData(data);
    }
    const vs = volSeriesRef.current;
    if (vs) {
      const div = 10 ** volumeDecimals;
      const volData: HistogramData[] = candles.map((c) => ({
        time: c.time as UTCTimestamp,
        value: Number(BigInt(c.volume)) / div,
        color: c.close >= c.open
          ? 'rgba(0, 246, 210, 0.55)'
          : 'rgba(242, 95, 91, 0.55)',
      }));
      vs.setData(volData);
    }
    // Only fit on first load for this chart instance — later updates
    // (polling, pagination prepends) must preserve the user's view.
    if (!didFitRef.current && candles.length > 0) {
      chartRef.current?.timeScale().fitContent();
      didFitRef.current = true;
    }
  }, [candles, style, volumeDecimals]);

  // Live trade preview — two horizontal price lines on the main series.
  useEffect(() => {
    const s = seriesRef.current;
    if (!s) return;
    // Always tear down on change; re-create when there's something to show.
    if (previewEffRef.current)  { s.removePriceLine(previewEffRef.current);  previewEffRef.current  = null; }
    if (!tradePreview) return;
    if (!Number.isFinite(tradePreview.effectiveRate)) return;

    // Colour by impact severity, matching the swap panel's thresholds:
    // <1% neutral, 1–5% amber, ≥5% red. Neutral (not teal) so the line stays
    // distinct from the teal price series / last-value marker.
    const sev = Math.abs(tradePreview.impactPct);
    const color = sev < 1 ? 'rgba(255, 255, 255, 0.7)' : sev < 5 ? '#f0c14b' : '#f25f5b';
    previewEffRef.current = s.createPriceLine({
      price: tradePreview.effectiveRate,
      color,
      lineWidth: 2,
      lineStyle: LineStyle.Solid,
      axisLabelVisible: true,
      title: tradePreview.label,
    });
  }, [tradePreview]);

  return (
    <Wrap ref={wrapRef}>
      <Inner ref={innerRef} />
      <Legend ref={legendRef} />
    </Wrap>
  );
};
