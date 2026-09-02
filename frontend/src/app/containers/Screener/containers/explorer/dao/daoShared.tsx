import React, { useCallback, useEffect, useRef, useState } from 'react';
import { styled } from '@linaria/react';
import type { AreaData, IChartApi, ISeriesApi, UTCTimestamp } from 'lightweight-charts';
import { theme } from '../shared';
import { Overlay, useEscapeClose } from '../../../components/modalChrome';
import { fmtCompact, fromGroths } from '../../../components/format';
import {
  createBeamChart,
  ChartWrap,
  ChartInner,
  ChartLegend,
  clearChildren,
  makeSpan,
} from '../../../components/chartTheme';

// Shared bits for the DAO pages: BEAMX/USD formatters, a stacked tally bar, a
// dependency-free SVG sparkline, and the DAO time-series chart (a thin wrapper
// over the terminal's shared lightweight-charts theme, so every DAO page reads
// its dates/values with the same crosshair + axes as the rest of the explorer).

export function grothToBeamx(groth: string | number | null | undefined): number {
  return fromGroths(groth, 8);
}

export { fmtCompact };

export function fmtBeamx(groth: string | number | null | undefined): string {
  return `${fmtCompact(grothToBeamx(groth))} BEAMX`;
}

export function fmtUsd(n: number | null | undefined): string {
  return n == null ? '—' : `$${fmtCompact(n)}`;
}

export function variantColor(variant: number): string {
  if (variant === 1) return theme.color.accent; // Yes
  if (variant === 0) return theme.color.danger; // No
  return theme.color.purple;
}

const BarRoot = styled.div`
  display: flex;
  height: 10px;
  border-radius: 4px;
  overflow: hidden;
  background: ${theme.color.surface2};
  margin: 8px 0 6px;
`;

export const TallyBar: React.FC<{ tallies: ReadonlyArray<{ variant: number; pct: number }> }> = ({ tallies }) => (
  <BarRoot>
    {tallies.map((t) => (
      <div key={t.variant} style={{ width: `${t.pct}%`, height: '100%', background: variantColor(t.variant) }} />
    ))}
  </BarRoot>
);

// "YYYY-MM-DD" (or "YYYY-MM") → unix-seconds at UTC midnight. lightweight-charts
// wants a numeric UTCTimestamp; using a real timestamp (not an ordinal index)
// gives an honest, auto-formatted date axis and an exact-match crosshair lookup.
function dayToTs(label: string): number {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(label);
  if (!m) return NaN;
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, m[3] ? Number(m[3]) : 1) / 1000);
}

const ChartEmpty = styled.div`
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: ${theme.color.muted};
  font-size: 12px;
`;
const TimeChartLegend = styled(ChartLegend)`
  display: flex;
  align-items: baseline;
  & > * + * {
    margin-left: 8px;
  }
  & .val {
    color: #fff;
    font-weight: 600;
    font-size: 13px;
  }
  & .day {
    color: rgba(255, 255, 255, 0.45);
  }
`;

// Single-series area chart of a dated value series (treasury value, revenue,
// voting power…). Same call signature as the old SVG version — `data` is
// `{label:"YYYY-MM-DD", value}` — so every existing caller upgrades for free.
export const TimeChart: React.FC<{
  data: ReadonlyArray<{ label: string; value: number }>;
  height?: number;
  color?: string;
  fmtY?: (n: number) => string;
}> = ({ data, height = 220, color = theme.color.accent, fmtY }) => {
  const innerRef = useRef<HTMLDivElement>(null);
  const legendRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Area'> | null>(null);
  const byTs = useRef<Map<number, { label: string; value: number }>>(new Map());
  const fyRef = useRef<(n: number) => string>(fmtY ?? ((n: number) => fmtCompact(n)));
  fyRef.current = fmtY ?? ((n: number) => fmtCompact(n));

  // Build the chart once; feed data in the second effect so updates don't tear
  // down the canvas (which would drop the user's pan/zoom on every 60s poll).
  useEffect(() => {
    const el = innerRef.current;
    if (!el) return undefined;
    const chart = createBeamChart(el, { rightPriceScale: { scaleMargins: { top: 0.16, bottom: 0.08 } } });
    chartRef.current = chart;
    const series = chart.addAreaSeries({
      lineColor: color,
      lineWidth: 2,
      topColor: 'rgba(0, 246, 210, 0.28)',
      bottomColor: 'rgba(0, 246, 210, 0.0)',
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerRadius: 4,
      priceFormat: { type: 'custom', formatter: (v: number) => fyRef.current(v), minMove: 0.000001 },
    });
    seriesRef.current = series;

    const lg = legendRef.current;
    let val: HTMLSpanElement | null = null;
    let day: HTMLSpanElement | null = null;
    if (lg) {
      clearChildren(lg);
      val = makeSpan('val', '');
      day = makeSpan('day', '');
      lg.appendChild(val);
      lg.appendChild(day);
    }
    const paint = (p: { label: string; value: number } | undefined): void => {
      if (val) val.textContent = p ? fyRef.current(p.value) : '';
      if (day) day.textContent = p ? p.label : '';
    };
    const latest = (): { label: string; value: number } | undefined => {
      const arr = [...byTs.current.values()];
      return arr[arr.length - 1];
    };
    paint(latest());
    chart.subscribeCrosshairMove((param) => {
      const p = param && param.time ? byTs.current.get(param.time as number) : undefined;
      paint(p ?? latest());
    });

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [color]);

  useEffect(() => {
    const s = seriesRef.current;
    if (!s) return;
    const map = new Map<number, { label: string; value: number }>();
    for (const d of data) {
      if (!Number.isFinite(d.value)) continue;
      const ts = dayToTs(d.label);
      if (!Number.isFinite(ts)) continue;
      map.set(ts, { label: d.label, value: d.value }); // last value wins on a duplicate day
    }
    const sorted = [...map.entries()].sort((a, b) => a[0] - b[0]);
    byTs.current = new Map(sorted);
    const chartData: AreaData[] = sorted.map(([ts, p]) => ({ time: ts as UTCTimestamp, value: p.value }));
    s.setData(chartData);
    if (chartData.length > 0) chartRef.current?.timeScale().fitContent();
    // Keep the idle (no-crosshair) legend showing the latest point after a poll.
    const lg = legendRef.current;
    const last = sorted.length ? sorted[sorted.length - 1][1] : undefined;
    if (lg && lg.children[0] && lg.children[1]) {
      (lg.children[0] as HTMLElement).textContent = last ? fyRef.current(last.value) : '';
      (lg.children[1] as HTMLElement).textContent = last ? last.label : '';
    }
  }, [data]);

  return (
    <ChartWrap h={`${height}px`}>
      <ChartInner ref={innerRef} />
      {data.length < 2 && <ChartEmpty>Not enough data yet</ChartEmpty>}
      <TimeChartLegend ref={legendRef} />
    </ChartWrap>
  );
};

export type PillTone = 'accent' | 'danger' | 'warn' | 'neutral';

export function outcomeTone(status: string, outcome: string | null): PillTone {
  if (status === 'live') return 'warn';
  if (outcome === 'passed') return 'accent';
  if (outcome === 'failed') return 'danger';
  return 'neutral';
}

export function outcomeLabel(status: string, outcome: string | null): string {
  if (status === 'live') return 'Live';
  if (outcome === 'passed') return 'Passed';
  if (outcome === 'failed') return 'Failed';
  return 'Closed';
}

// External link with a "you are leaving BeamTerminal" interstitial that shows
// the full URL before opening it. Only http(s) is ever navigable (proposal
// links are attacker-controlled); anything else renders as plain text.
const ExtModal = styled.div`
  width: 90%;
  max-width: 440px;
  background: ${theme.color.bg};
  border: 1px solid ${theme.color.border};
  border-radius: ${theme.radius.lg};
  overflow: hidden;
`;
const ExtHead = styled.div`
  padding: 14px 16px;
  border-bottom: 1px solid ${theme.color.borderDim};
  font-weight: 700;
  color: ${theme.color.text};
`;
const ExtBody = styled.div`
  padding: 16px;
  & > p {
    margin: 0 0 12px;
    color: ${theme.color.muted};
    font-size: 13px;
  }
`;
const ExtUrl = styled.div`
  background: ${theme.color.surface2};
  border: 1px solid ${theme.color.borderDim};
  border-radius: 6px;
  padding: 10px 12px;
  font-size: 12px;
  color: ${theme.color.accent};
  word-break: break-all;
  margin-bottom: 16px;
`;
const ExtActions = styled.div`
  display: flex;
  justify-content: flex-end;
  /* Owl margins, not gap — flex gap is unsupported in the wallet's Chrome 83. */
  & > * + * {
    margin-left: 10px;
  }
`;
const ExtCancel = styled.button`
  padding: 8px 16px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  background: transparent;
  border: 1px solid ${theme.color.border};
  color: ${theme.color.muted};
  cursor: pointer;
  &:hover {
    color: ${theme.color.text};
    border-color: ${theme.color.muted};
  }
`;
const ExtOpen = styled.a`
  padding: 8px 16px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 700;
  background: ${theme.color.accent};
  border: 1px solid ${theme.color.accent};
  cursor: pointer;
  &,
  &:link,
  &:visited,
  &:hover {
    color: #04121e;
    text-decoration: none;
  }
`;

export const ExternalLink: React.FC<{ href?: string; className?: string; children: React.ReactNode }> = ({
  href,
  className,
  children,
}) => {
  const [open, setOpen] = useState(false);
  const closeConfirm = useCallback(() => setOpen(false), []);
  useEscapeClose(closeConfirm, open);
  if (!href || !/^https?:\/\//i.test(href)) return <>{children}</>;
  return (
    <>
      <a
        href={href}
        className={className}
        onClick={(e) => {
          e.preventDefault();
          setOpen(true);
        }}
      >
        {children}
      </a>
      {open && (
        <Overlay z={60} backdrop="rgba(2, 12, 24, 0.82)" pad="0" onClick={closeConfirm}>
          <ExtModal onClick={(e) => e.stopPropagation()}>
            <ExtHead>You are leaving BeamTerminal</ExtHead>
            <ExtBody>
              <p>Are you sure you want to open this external URL?</p>
              <ExtUrl>{href}</ExtUrl>
              <ExtActions>
                <ExtCancel type="button" onClick={() => setOpen(false)}>
                  Cancel
                </ExtCancel>
                <ExtOpen href={href} target="_blank" rel="noopener noreferrer" onClick={() => setOpen(false)}>
                  Open ↗
                </ExtOpen>
              </ExtActions>
            </ExtBody>
          </ExtModal>
        </Overlay>
      )}
    </>
  );
};
