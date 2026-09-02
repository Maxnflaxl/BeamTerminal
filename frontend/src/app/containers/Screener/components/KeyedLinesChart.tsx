import React, { useEffect, useMemo, useRef, useState } from 'react';
import { styled } from '@linaria/react';
import { PriceScaleMode, type IChartApi, type ISeriesApi, type LineData, type UTCTimestamp } from 'lightweight-charts';
import { PALLETE_ASSETS } from '@app/shared/constants';
import { theme } from '../containers/explorer/shared/theme';
import { clearChildren, createBeamChart, makeSpan } from './chartTheme';
import type { ApiKeyedSeries } from '../api/client';
import { fmtDayLocal } from './format';

// Colour is bound to the series' own key, never to its position in the
// response: filtering a line out, or the server reordering the groups, must
// never repaint the lines that survive. Two bridges move the same asset, so an
// asset-id palette would collide them onto one colour and hide one behind the
// other — hence a key-keyed table with a deterministic hash fallback for keys
// that aren't listed here.
const KEY_COLORS: Record<string, string> = {
  'beam-wbeam': theme.color.accent,
  'beam-wbeam-arb': theme.color.info,
  beth: theme.color.purple,
  busdt: theme.color.warn,
  bwbtc: PALLETE_ASSETS[2],
  bdai: theme.color.danger,
  // The direction keys get colours of their own rather than sharing a bridge's:
  // a chart that offers a total / by-direction / by-bridge toggle can put both
  // families in front of the same eyes.
  beam2eth: PALLETE_ASSETS[6],
  eth2beam: PALLETE_ASSETS[13],
};

// Colours already spoken for above, so the hash fallback can't hand an unlisted
// key a colour a listed one is already using.
const RESERVED_COLORS = new Set(Object.values(KEY_COLORS));

// FNV-1a, so an unlisted key still lands on a stable palette slot.
function hashKey(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

// Hash to a slot, then probe forward past the reserved colours. The probe reads
// only the key and the constant table — never the set of series on screen — so
// hiding a line or switching split mode can't repaint the ones that remain.
function fallbackColor(key: string): string {
  const start = hashKey(key) % PALLETE_ASSETS.length;
  for (let i = 0; i < PALLETE_ASSETS.length; i += 1) {
    const c = PALLETE_ASSETS[(start + i) % PALLETE_ASSETS.length];
    if (!RESERVED_COLORS.has(c)) return c;
  }
  return PALLETE_ASSETS[start];
}

export function buildKeyedColors(series: ReadonlyArray<ApiKeyedSeries>): Map<string, string> {
  const map = new Map<string, string>();
  for (const s of series) map.set(s.key, KEY_COLORS[s.key] ?? fallbackColor(s.key));
  return map;
}

/** What a gap in a series means.
 *
 *  `hold` — the series is a *balance* (a locked amount, a burn total). A bucket
 *  with no point is a bucket nothing happened in, so the previous level still
 *  stands and must be carried forward.
 *
 *  `zero` — the series is a *flow* (transfers per day). A bucket with no point
 *  is a bucket with no activity, which is zero, not "still whatever it was last
 *  time". Carrying a flow forward invents a plateau: a bridge with two transfers
 *  on one day would otherwise read 2/day for every day until its next transfer.
 *
 *  Every consumer of a keyed/multi series has to agree on this — the on-screen
 *  line, the timeframe filter, and the CSV/SVG exports all sample the same data
 *  and would otherwise contradict each other. */
export type SeriesFill = 'hold' | 'zero';

// lightweight-charts spaces points by index, not by elapsed time, and the
// groups don't share a timestamp grid (a bridge that saw no activity has no
// point that day). Resample every series onto the union of all timestamps so
// the crosshair reads one instant across every line — filling the gaps the way
// `fill` says the series' gaps mean.
export function resampleKeyed(
  series: ReadonlyArray<ApiKeyedSeries>,
  fill: SeriesFill = 'hold',
): Map<string, LineData[]> {
  const out = new Map<string, LineData[]>();
  const times = new Set<number>();
  for (const s of series) for (const p of s.points) times.add(p.ts);
  const grid = Array.from(times).sort((a, b) => a - b);
  for (const s of series) {
    const pts = s.points.slice().sort((a, b) => a.ts - b.ts);
    const data: LineData[] = [];
    if (fill === 'zero') {
      // Zeros start at the series' own first point, never before it: a bridge
      // that did not exist yet has no activity to report, and back-filling
      // would draw it flat along the axis from the start of history.
      const first = pts[0];
      if (first) {
        const byTs = new Map<number, number>();
        for (const p of pts) byTs.set(p.ts, p.value);
        for (const t of grid) {
          if (t < first.ts) continue;
          data.push({ time: t as UTCTimestamp, value: byTs.get(t) ?? 0 });
        }
      }
      out.set(s.key, data);
      continue;
    }
    let i = 0;
    let cur: number | null = null;
    for (const t of grid) {
      while (i < pts.length && pts[i]!.ts <= t) {
        cur = pts[i]!.value;
        i += 1;
      }
      if (cur == null) continue;
      data.push({ time: t as UTCTimestamp, value: cur });
    }
    out.set(s.key, data);
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

// flex/grid `gap` isn't supported on the wallet's QtWebEngine 5.15.2
// (Chrome 83) — spacing comes from margins.
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

  &:hover {
    color: #00f6d2;
  }
`;

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

// Crosshair readout, positioned imperatively (translate3d) from the crosshair
// handler so a mouse move costs no React render.
const Tooltip = styled.div`
  position: absolute;
  top: 0;
  left: 0;
  z-index: 6;
  display: none;
  max-width: 280px;
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

  & > .row > .sw {
    flex: 0 0 auto;
    width: 10px;
    height: 0;
    margin-right: 6px;
    border-top-width: 2px;
    border-top-style: solid;
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

interface Props {
  series: ReadonlyArray<ApiKeyedSeries>;
  logScale?: boolean;
  formatter: (v: number) => string;
  /** Whether a gap means "the level still holds" or "nothing happened". */
  fill?: SeriesFill;
}

/** Multi-line chart for series identified by string key. Click a legend entry
 *  to hide a line, double-click to isolate it. */
export const KeyedLinesChart: React.FC<Props> = ({ series, logScale = false, formatter, fill = 'hold' }) => {
  const innerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<Map<string, ISeriesApi<'Line'>>>(new Map());
  const tooltipRef = useRef<HTMLDivElement>(null);
  // Pinned price range, read by every series' autoscaleInfoProvider so a
  // horizontal pan doesn't rescale the y-axis every frame.
  const priceRangeRef = useRef<{ min: number; max: number } | null>(null);
  const focusedRef = useRef<string | null>(null);
  // Cached tooltip rows so a mouse move rewrites text instead of rebuilding
  // the element list. `sig` is the key order they were built in.
  const tipRowsRef = useRef<{
    sig: string;
    when: HTMLDivElement | null;
    rows: Map<string, { row: HTMLDivElement; val: HTMLSpanElement }>;
  }>({ sig: '', when: null, rows: new Map() });
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  const colorByKey = useMemo(() => buildKeyedColors(series), [series]);
  const chartData = useMemo(() => resampleKeyed(series, fill), [series, fill]);

  // Latest view state for the crosshair handler, which subscribes once per
  // chart and must not close over stale values.
  const viewRef = useRef({ series, colorByKey, hidden, formatter });
  viewRef.current = { series, colorByKey, hidden, formatter };

  const priceRange = useMemo(() => {
    let min = Infinity;
    let max = -Infinity;
    for (const s of series) {
      if (hidden.has(s.key)) continue;
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

  useEffect(() => {
    priceRangeRef.current = priceRange;
    chartRef.current?.priceScale('right').applyOptions({ autoScale: true });
  }, [priceRange]);

  useEffect(() => {
    const el = innerRef.current;
    if (!el) return undefined;
    const chart = createBeamChart(el, {
      // Pin the price-axis gutter. Without it the gutter resizes as tick labels
      // change width ("5.00k" → "4.60M"), reflowing the plot every frame.
      rightPriceScale: { minimumWidth: 88 },
      timeScale: { minBarSpacing: 0.01 },
    });
    chartRef.current = chart;

    chart.subscribeCrosshairMove((param) => {
      const tip = tooltipRef.current;
      const host = innerRef.current;
      if (!tip || !host) return;
      const { series: ser, colorByKey: colors, hidden: hid, formatter: fmt } = viewRef.current;

      const rows: Array<{ key: string; label: string; value: number; y: number | null }> = [];
      if (param && param.time != null && param.point) {
        for (const s of ser) {
          if (hid.has(s.key)) continue;
          const line = seriesRef.current.get(s.key);
          if (!line) continue;
          const d = param.seriesData.get(line) as { value?: number } | undefined;
          if (!d || typeof d.value !== 'number') continue;
          rows.push({ key: s.key, label: s.label, value: d.value, y: line.priceToCoordinate(d.value) });
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
      // Thicken the line nearest the cursor so one series stays followable
      // through a bundle of overlapping curves.
      let focus: string | null = null;
      let best = Infinity;
      for (const r of rows) {
        if (r.y == null) continue;
        const d = Math.abs(r.y - param.point!.y);
        if (d < best) {
          best = d;
          focus = r.key;
        }
      }
      if (focus !== focusedRef.current) {
        focusedRef.current = focus;
        for (const [key, line] of seriesRef.current) line.applyOptions({ lineWidth: key === focus ? 3 : 2 });
      }

      const sig = rows.map((r) => r.key).join(',');
      const cache = tipRowsRef.current;
      if (cache.sig !== sig) {
        clearChildren(tip);
        cache.rows = new Map();
        cache.sig = sig;
        const whenRow = document.createElement('div');
        whenRow.className = 'when';
        tip.appendChild(whenRow);
        cache.when = whenRow;
        for (const r of rows) {
          const row = document.createElement('div');
          row.className = 'row';
          const sw = makeSpan('sw');
          sw.style.borderTopColor = colors.get(r.key) ?? '#fff';
          const lbl = makeSpan('lbl', r.label);
          const val = makeSpan('val');
          row.appendChild(sw);
          row.appendChild(lbl);
          row.appendChild(val);
          tip.appendChild(row);
          cache.rows.set(r.key, { row, val });
        }
      }
      if (cache.when) cache.when.textContent = fmtDayLocal(param.time as number);
      for (const r of rows) {
        const node = cache.rows.get(r.key);
        if (!node) continue;
        node.val.textContent = fmt(r.value);
        node.row.className = r.key === focus ? 'row on' : 'row';
      }

      tip.style.display = 'block';
      const w = tip.offsetWidth;
      const h = tip.offsetHeight;
      const right = param.point!.x + 16;
      const x = right + w <= host.clientWidth ? right : Math.max(4, param.point!.x - 16 - w);
      const y = Math.min(Math.max(4, param.point!.y - h / 2), Math.max(4, host.clientHeight - h - 4));
      tip.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    });

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current.clear();
    };
  }, [formatter]);

  useEffect(() => {
    chartRef.current?.priceScale('right').applyOptions({
      mode: logScale ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal,
    });
  }, [logScale]);

  // (Re)build the line set whenever the data changes. Cheap enough (a handful
  // of series, one fetch per view) to drop and re-add rather than diff.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return undefined;
    for (const s of seriesRef.current.values()) chart.removeSeries(s);
    seriesRef.current.clear();
    for (const s of series) {
      const line = chart.addLineSeries({
        color: colorByKey.get(s.key),
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: true,
        visible: !hidden.has(s.key),
        priceFormat: { type: 'custom', formatter, minMove: 0.00000001 },
        autoscaleInfoProvider: () => {
          const r = priceRangeRef.current;
          return r ? { priceRange: { minValue: r.min, maxValue: r.max } } : null;
        },
      });
      line.setData(chartData.get(s.key) ?? []);
      seriesRef.current.set(s.key, line);
    }
    if (series.length === 0) return undefined;
    const ts = chart.timeScale();
    ts.fitContent();
    // The expanded modal mounts the chart before its layout settles, and
    // fitContent on a zero-width plot squeezes the whole range into a sliver at
    // the right edge. Retry (bounded) until the plot actually has a width.
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
    return () => {
      if (raf) cancelAnimationFrame(raf);
    };
    // `hidden` is applied by the effect below so a legend toggle doesn't
    // rebuild every series.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, chartData, colorByKey, formatter]);

  useEffect(() => {
    for (const [key, line] of seriesRef.current) line.applyOptions({ visible: !hidden.has(key) });
  }, [hidden]);

  const toggle = (key: string): void => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Double-click isolates one line, and a second double-click brings them all
  // back. The two single clicks that precede it toggle the same key twice — a
  // net no-op — so this needs no click timer.
  const isolate = (key: string): void => {
    setHidden((prev) => {
      const alone = !prev.has(key) && series.every((s) => s.key === key || prev.has(s.key));
      return alone ? new Set<string>() : new Set(series.filter((s) => s.key !== key).map((s) => s.key));
    });
  };

  return (
    <Wrap>
      <Legend>
        {series.map((s) => (
          <LegendItem
            key={s.key}
            type="button"
            off={hidden.has(s.key)}
            onClick={() => toggle(s.key)}
            onDoubleClick={() => isolate(s.key)}
            title={hidden.has(s.key) ? 'Show' : 'Hide (double-click to isolate)'}
          >
            <i style={{ borderTopColor: colorByKey.get(s.key) }} />
            {s.label}
          </LegendItem>
        ))}
      </Legend>
      <Plot>
        <Inner ref={innerRef} />
        <Tooltip ref={tooltipRef} />
      </Plot>
    </Wrap>
  );
};

export default KeyedLinesChart;
