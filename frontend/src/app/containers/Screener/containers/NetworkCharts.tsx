import React, { useEffect, useMemo, useState } from 'react';
import { styled } from '@linaria/react';
import { api, type ApiChartPoint, type ApiChartSeries } from '../api/client';
import { SimpleChart } from '../components/SimpleChart';

type Timeframe = '1W' | '1M' | '3M' | 'YTD' | 'ALL';
const TIMEFRAMES: ReadonlyArray<Timeframe> = ['1W', '1M', '3M', 'YTD', 'ALL'];
const TIMEFRAME_DAYS: Record<Timeframe, number | null> = { '1W': 7, '1M': 30, '3M': 90, YTD: -1, ALL: null };

function filterByTimeframe(series: ReadonlyArray<ApiChartPoint>, tf: Timeframe): ApiChartPoint[] {
  if (series.length === 0) return [];
  const days = TIMEFRAME_DAYS[tf];
  if (days === null) return series.slice();
  let cutoff: number;
  if (tf === 'YTD') {
    const last = series[series.length - 1].ts;
    const year = new Date(last * 1000).getUTCFullYear();
    cutoff = Date.UTC(year, 0, 1) / 1000;
  } else {
    cutoff = series[series.length - 1].ts - (days as number) * 86400;
  }
  return series.filter((p) => p.ts >= cutoff);
}

interface FetchState<T> { data: T | null; loading: boolean; error: string | null }

function useOneShot<T>(fetcher: () => Promise<T>): FetchState<T> {
  const [state, setState] = useState<FetchState<T>>({ data: null, loading: true, error: null });
  useEffect(() => {
    let cancelled = false;
    fetcher()
      .then((data) => { if (!cancelled) setState({ data, loading: false, error: null }); })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({ data: null, loading: false, error: err instanceof Error ? err.message : String(err) });
      });
    return () => { cancelled = true; };
    // Run once on mount; chart endpoints have a 10–30min server cache anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return state;
}

const Page = styled.div`
  width: 100%;
  max-width: 1200px;
  margin: 0 auto;
  padding: 16px;
`;

const Toolbar = styled.div`
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  margin-bottom: 12px;
`;

const TfButton = styled.button<{ active?: boolean }>`
  background: ${(p) => (p.active ? 'rgba(0, 246, 210, 0.18)' : 'transparent')};
  color: ${(p) => (p.active ? '#00f6d2' : 'rgba(255, 255, 255, 0.6)')};
  border: 1px solid ${(p) => (p.active ? 'rgba(0, 246, 210, 0.5)' : 'rgba(255, 255, 255, 0.12)')};
  border-radius: 6px;
  padding: 4px 10px;
  font-family: 'SFProDisplay', monospace;
  font-size: 12px;
  cursor: pointer;
  transition: background 120ms, color 120ms, border-color 120ms;

  &:hover {
    color: #00f6d2;
    border-color: rgba(0, 246, 210, 0.5);
  }
`;

const Grid = styled.div`
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;

  @media (max-width: 800px) {
    grid-template-columns: 1fr;
  }
`;

const Cell = styled.div`
  background: #042548;
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 8px;
  padding: 8px;
  height: 320px;
  position: relative;
`;

const ExpandButton = styled.button`
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 20;
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.25);
  color: rgba(255, 255, 255, 0.6);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 4px;
  cursor: pointer;
  padding: 0;
  transition: color 120ms, border-color 120ms, background 120ms;

  &:hover {
    color: #00f6d2;
    border-color: rgba(0, 246, 210, 0.5);
    background: rgba(0, 246, 210, 0.12);
  }
`;

const ExpandIcon: React.FC = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="7 1 11 1 11 5" />
    <polyline points="5 11 1 11 1 7" />
    <line x1="11" y1="1" x2="7" y2="5" />
    <line x1="1" y1="11" x2="5" y2="7" />
  </svg>
);

const ModalBackdrop = styled.div`
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.65);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  padding: 24px;
`;

const ModalContent = styled.div`
  background: #042548;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  width: 100%;
  max-width: 1200px;
  height: 100%;
  max-height: 760px;
  display: flex;
  flex-direction: column;
  padding: 16px;
  position: relative;
`;

const ModalToolbar = styled.div`
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  margin-bottom: 12px;
  padding-right: 36px;
`;

const ModalBody = styled.div`
  flex: 1;
  min-height: 0;
  background: #042548;
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 8px;
  padding: 8px;
`;

const CloseButton = styled.button`
  position: absolute;
  top: 12px;
  right: 12px;
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  color: rgba(255, 255, 255, 0.7);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 6px;
  cursor: pointer;
  font-size: 16px;
  line-height: 1;

  &:hover {
    color: #00f6d2;
    border-color: rgba(0, 246, 210, 0.5);
  }
`;

const Loading = styled.div`
  color: rgba(255, 255, 255, 0.5);
  text-align: center;
  padding: 80px 0;
  font-size: 13px;
`;

function fmtUsd(v: number): string {
  if (!Number.isFinite(v)) return '';
  if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'k';
  return '$' + v.toFixed(2);
}

function fmtSIUnit(v: number, unit: string): string {
  if (!Number.isFinite(v)) return '';
  const abs = Math.abs(v);
  if (abs >= 1e12) return (v / 1e12).toFixed(2) + ' T' + unit;
  if (abs >= 1e9)  return (v / 1e9).toFixed(2)  + ' G' + unit;
  if (abs >= 1e6)  return (v / 1e6).toFixed(2)  + ' M' + unit;
  if (abs >= 1e3)  return (v / 1e3).toFixed(0)  + ' K' + unit;
  return v.toFixed(0) + ' ' + unit;
}

function fmtHashrate(v: number): string {
  return fmtSIUnit(v, 'Sol/s');
}

function fmtDifficulty(v: number): string {
  if (!Number.isFinite(v)) return '';
  const abs = Math.abs(v);
  if (abs >= 1e12) return (v / 1e12).toFixed(2) + 'T';
  if (abs >= 1e9)  return (v / 1e9).toFixed(2)  + 'G';
  if (abs >= 1e6)  return (v / 1e6).toFixed(2)  + 'M';
  if (abs >= 1e3)  return (v / 1e3).toFixed(2)  + 'K';
  return v.toFixed(0);
}

function fmtInt(v: number): string {
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k';
  return v.toFixed(0);
}

interface ChartCellProps {
  state: FetchState<ApiChartSeries>;
  title: string;
  timeframe: Timeframe;
  scale?: number;
  formatter?: (v: number) => string;
  onExpand: () => void;
}

const ChartCell: React.FC<ChartCellProps> = ({ state, title, timeframe, scale, formatter, onExpand }) => {
  const filtered = useMemo(
    () => (state.data ? filterByTimeframe(state.data.series, timeframe) : null),
    [state.data, timeframe],
  );
  return (
    <Cell>
      <ExpandButton onClick={onExpand} title="Expand chart" aria-label="Expand chart">
        <ExpandIcon />
      </ExpandButton>
      {filtered ? (
        <SimpleChart series={filtered} title={title} scale={scale} formatter={formatter} />
      ) : (
        <Loading>{state.error ?? (state.loading ? 'Loading…' : 'No data')}</Loading>
      )}
    </Cell>
  );
};

interface ChartSpec {
  key: string;
  title: string;
  state: FetchState<ApiChartSeries>;
  scale?: number;
  formatter: (v: number) => string;
}

export const NetworkCharts: React.FC = () => {
  const hashrate   = useOneShot<ApiChartSeries>(() => api.charts.hashrate());
  const difficulty = useOneShot<ApiChartSeries>(() => api.charts.difficulty());
  const kernels    = useOneShot<ApiChartSeries>(() => api.charts.kernels());
  const dexVolume  = useOneShot<ApiChartSeries>(() => api.charts.dexVolume());
  const assets     = useOneShot<ApiChartSeries>(() => api.charts.assets());

  const [timeframe, setTimeframe] = useState<Timeframe>('ALL');
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  const charts: ReadonlyArray<ChartSpec> = [
    { key: 'hashrate',   title: 'Hashrate (Beamhash III)', state: hashrate,   formatter: fmtHashrate },
    { key: 'difficulty', title: 'Difficulty',              state: difficulty, formatter: fmtDifficulty },
    { key: 'kernels',    title: 'Kernels / day',           state: kernels,    formatter: fmtInt },
    { key: 'dexVolume',  title: 'DEX volume / day',        state: dexVolume,  formatter: fmtUsd },
    { key: 'assets',     title: 'Confidential Assets',     state: assets,     formatter: fmtInt },
  ];

  const expanded = expandedKey ? charts.find((c) => c.key === expandedKey) ?? null : null;

  useEffect(() => {
    if (!expanded) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setExpandedKey(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);

  return (
    <Page>
      <Toolbar>
        {TIMEFRAMES.map((tf) => (
          <TfButton
            key={tf}
            active={timeframe === tf}
            onClick={() => setTimeframe(tf)}
          >
            {tf}
          </TfButton>
        ))}
      </Toolbar>
      <Grid>
        {charts.map((c) => (
          <ChartCell
            key={c.key}
            state={c.state}
            title={c.title}
            timeframe={timeframe}
            scale={c.scale}
            formatter={c.formatter}
            onExpand={() => setExpandedKey(c.key)}
          />
        ))}
      </Grid>
      {expanded && (
        <ModalBackdrop onClick={() => setExpandedKey(null)}>
          <ModalContent onClick={(e) => e.stopPropagation()}>
            <CloseButton onClick={() => setExpandedKey(null)} aria-label="Close">×</CloseButton>
            <ModalToolbar>
              {TIMEFRAMES.map((tf) => (
                <TfButton
                  key={tf}
                  active={timeframe === tf}
                  onClick={() => setTimeframe(tf)}
                >
                  {tf}
                </TfButton>
              ))}
            </ModalToolbar>
            <ModalBody>
              <ExpandedChart
                state={expanded.state}
                title={expanded.title}
                timeframe={timeframe}
                scale={expanded.scale}
                formatter={expanded.formatter}
              />
            </ModalBody>
          </ModalContent>
        </ModalBackdrop>
      )}
    </Page>
  );
};

const ExpandedChart: React.FC<Omit<ChartCellProps, 'onExpand'>> = ({ state, title, timeframe, scale, formatter }) => {
  const filtered = useMemo(
    () => (state.data ? filterByTimeframe(state.data.series, timeframe) : null),
    [state.data, timeframe],
  );
  if (!filtered) return <Loading>{state.error ?? (state.loading ? 'Loading…' : 'No data')}</Loading>;
  return <SimpleChart series={filtered} title={title} scale={scale} formatter={formatter} />;
};

export default NetworkCharts;
