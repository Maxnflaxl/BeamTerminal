import type { ZoomRes } from '../lib/zoomResolution';

// ---------------------------------------------------------------------------
// The query-string form of "this chart, opened, looking like this".
//
// A link has to survive being pasted somewhere and opened cold, so the
// vocabulary is closed on both ends: an unknown value parses back to the
// default rather than into the component's state, where a bogus timeframe or
// interval would reach the fetchers and render an empty chart.
//
// Only a chart that is actually expanded writes these params. The grid's own
// URL stays bare, and closing the chart takes the whole set back out.
// ---------------------------------------------------------------------------

export type ChartTimeframe = '1D' | '1W' | '1M' | '3M' | 'YTD' | 'ALL';
export type ChartSplit = 'none' | 'direction' | 'bridge';
export type ChartIntervalParam = ZoomRes | 'auto';

export interface ChartLink {
  /** Chart key, matching a ChartSpec in the grid. */
  key: string;
  timeframe: ChartTimeframe;
  interval: ChartIntervalParam;
  log: boolean;
  split: ChartSplit;
}

export const CHART_LINK_DEFAULTS: Omit<ChartLink, 'key'> = {
  timeframe: 'ALL',
  interval: 'auto',
  log: false,
  split: 'none',
};

/** Every param this module owns, so a close can clear the set in one pass. */
export const CHART_LINK_PARAMS = ['chart', 'tf', 'iv', 'log', 'split'] as const;

const TIMEFRAMES = new Set<string>(['1D', '1W', '1M', '3M', 'YTD', 'ALL']);
const INTERVALS = new Set<string>(['auto', '1m', '1h', '1d', '1M']);
const SPLITS = new Set<string>(['none', 'direction', 'bridge']);

/**
 * The expanded chart described by `sp`, or null when no chart is linked.
 * `log` defaults per chart rather than globally — the Black Hole chart opens
 * logarithmic — so the caller passes the chart's own default in.
 */
export function parseChartLink(sp: URLSearchParams, logDefault = false): ChartLink | null {
  const key = sp.get('chart');
  if (!key) return null;

  const tf = sp.get('tf');
  const iv = sp.get('iv');
  const split = sp.get('split');
  const log = sp.get('log');

  return {
    key,
    timeframe: (tf && TIMEFRAMES.has(tf) ? tf : CHART_LINK_DEFAULTS.timeframe) as ChartTimeframe,
    interval: (iv && INTERVALS.has(iv) ? iv : CHART_LINK_DEFAULTS.interval) as ChartIntervalParam,
    log: log === null ? logDefault : log === '1',
    split: (split && SPLITS.has(split) ? split : CHART_LINK_DEFAULTS.split) as ChartSplit,
  };
}

/**
 * `sp` with this link's params written and every default dropped, so the
 * common link is just `?chart=<key>`. `log` is written whenever it differs
 * from the chart's own default, in either direction — a Black Hole chart
 * switched to linear needs `log=0` to survive the round trip.
 */
export function withChartLink(sp: URLSearchParams, link: ChartLink, logDefault = false): URLSearchParams {
  const next = new URLSearchParams(sp);
  next.set('chart', link.key);
  const put = (name: string, value: string, isDefault: boolean): void => {
    if (isDefault) next.delete(name);
    else next.set(name, value);
  };
  put('tf', link.timeframe, link.timeframe === CHART_LINK_DEFAULTS.timeframe);
  put('iv', link.interval, link.interval === CHART_LINK_DEFAULTS.interval);
  put('split', link.split, link.split === CHART_LINK_DEFAULTS.split);
  put('log', link.log ? '1' : '0', link.log === logDefault);
  return next;
}

/** `sp` with every chart-link param removed (what closing a chart leaves). */
export function withoutChartLink(sp: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(sp);
  for (const p of CHART_LINK_PARAMS) next.delete(p);
  return next;
}

/**
 * A link's identity as one comparable string ('' for no chart). Two-way sync
 * needs to know which side moved — the address bar or the component — and
 * comparing each side against the last agreed signature answers that, where a
 * plain "are they different?" cannot.
 */
export function chartLinkSignature(link: ChartLink | null): string {
  if (link === null) return '';
  return [link.key, link.timeframe, link.interval, link.log ? '1' : '0', link.split].join('|');
}
