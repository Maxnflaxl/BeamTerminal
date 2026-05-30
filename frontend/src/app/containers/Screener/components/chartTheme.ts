// Shared theme + scaffolding for the lightweight-charts components (the pair
// Chart, SimpleChart, SupplyChart, PoolHistoryChart, BlackholeChart). Keeps the
// chart palette, the base createChart() options, the wrapper/legend styled
// containers, and the legend-DOM helpers in one place instead of copy-pasted
// across every chart.

import { styled } from '@linaria/react';
import {
  createChart,
  ColorType,
  CrosshairMode,
  type ChartOptions,
  type DeepPartial,
  type IChartApi,
} from 'lightweight-charts';

// Single source for the chart palette. `accent`/`down` are also the series
// colours (teal up / red down), so charts read them from here instead of
// re-typing the hex literals.
export const CHART_COLORS = {
  bg: '#042548',
  text: 'rgba(255, 255, 255, 0.55)',
  grid: 'rgba(255, 255, 255, 0.04)',
  border: 'rgba(255, 255, 255, 0.1)',
  accent: '#00f6d2',
  accentDim: 'rgba(0, 246, 210, 0.4)',
  down: '#f25f5b',
} as const;

const BASE_OPTIONS: DeepPartial<ChartOptions> = {
  autoSize: true,
  layout: {
    background: { type: ColorType.Solid, color: CHART_COLORS.bg },
    textColor: CHART_COLORS.text,
    fontSize: 11,
  },
  grid: {
    vertLines: { color: CHART_COLORS.grid },
    horzLines: { color: CHART_COLORS.grid },
  },
  crosshair: {
    mode: CrosshairMode.Normal,
    vertLine: { color: CHART_COLORS.accentDim, width: 1, style: 0, labelBackgroundColor: CHART_COLORS.accent },
    horzLine: { color: CHART_COLORS.accentDim, width: 1, style: 0, labelBackgroundColor: CHART_COLORS.accent },
  },
  rightPriceScale: { borderColor: CHART_COLORS.border },
  timeScale: { borderColor: CHART_COLORS.border, timeVisible: false, secondsVisible: false },
};

// Shallow-merge one level into the nested option groups so a caller can tweak,
// say, `timeScale.rightOffset` without dropping the base `timeScale.borderColor`.
function mergeOptions(
  base: DeepPartial<ChartOptions>,
  over?: DeepPartial<ChartOptions>,
): DeepPartial<ChartOptions> {
  if (!over) return base;
  const out: Record<string, unknown> = { ...base };
  for (const [k, ov] of Object.entries(over)) {
    const bv = (base as Record<string, unknown>)[k];
    out[k] = bv && ov && typeof bv === 'object' && typeof ov === 'object' && !Array.isArray(ov)
      ? { ...(bv as object), ...(ov as object) }
      : ov;
  }
  return out as DeepPartial<ChartOptions>;
}

/** createChart() with the shared BeamTerminal theme; `overrides` deep-merge over
 *  the base (e.g. `{ timeScale: { rightOffset: 5 } }`). */
export function createBeamChart(el: HTMLElement, overrides?: DeepPartial<ChartOptions>): IChartApi {
  return createChart(el, mergeOptions(BASE_OPTIONS, overrides));
}

// --- shared container styled components -----------------------------------

/** Relative chart container. `h` sets the height (default 100%, for charts
 *  sized by their parent); `minH` sets a min-height for fixed-tall charts. */
export const ChartWrap = styled.div<{ h?: string; minH?: string }>`
  position: relative;
  width: 100%;
  height: ${(p) => p.h ?? '100%'};
  min-height: ${(p) => p.minH ?? '0'};
`;

export const ChartInner = styled.div`
  width: 100%;
  height: 100%;
`;

/** Base for the overlaid crosshair legend (position + font). Charts extend it
 *  with `styled(ChartLegend)` for their per-chart layout/colour rules. */
export const ChartLegend = styled.div`
  position: absolute;
  top: 8px;
  left: 12px;
  z-index: 10;
  pointer-events: none;
  font-family: 'SFProDisplay', monospace;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.7);
`;

// --- legend DOM helpers ----------------------------------------------------

/** Remove all children the long way — `Element.replaceChildren` needs Chrome
 *  86+, newer than the desktop wallet's QtWebEngine. */
export function clearChildren(el: HTMLElement): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** A `<span class>` with text — the building block of the crosshair legends. */
export function makeSpan(cls: string, txt = ''): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = cls;
  s.textContent = txt;
  return s;
}
