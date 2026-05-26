import React, { useEffect, useMemo, useState } from 'react';
import { styled } from '@linaria/react';
import { api, type ApiChartPoint, type ApiChartSeries } from '../api/client';
import { SimpleChart } from '../components/SimpleChart';

type Timeframe = '1W' | '1M' | '3M' | 'ALL';
const TIMEFRAMES: ReadonlyArray<Timeframe> = ['1W', '1M', '3M', 'ALL'];
const TIMEFRAME_DAYS: Record<Timeframe, number | null> = { '1W': 7, '1M': 30, '3M': 90, ALL: null };

function filterByTimeframe(series: ReadonlyArray<ApiChartPoint>, tf: Timeframe): ApiChartPoint[] {
  const days = TIMEFRAME_DAYS[tf];
  if (days === null || series.length === 0) return series.slice();
  const cutoff = series[series.length - 1].ts - days * 86400;
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

function fmtMSol(v: number): string {
  return v.toFixed(2);
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
}

const ChartCell: React.FC<ChartCellProps> = ({ state, title, timeframe, scale, formatter }) => {
  const filtered = useMemo(
    () => (state.data ? filterByTimeframe(state.data.series, timeframe) : null),
    [state.data, timeframe],
  );
  return (
    <Cell>
      {filtered ? (
        <SimpleChart series={filtered} title={title} scale={scale} formatter={formatter} />
      ) : (
        <Loading>{state.error ?? (state.loading ? 'Loading…' : 'No data')}</Loading>
      )}
    </Cell>
  );
};

export const NetworkCharts: React.FC = () => {
  const hashrate  = useOneShot<ApiChartSeries>(() => api.charts.hashrate());
  const kernels   = useOneShot<ApiChartSeries>(() => api.charts.kernels());
  const dexVolume = useOneShot<ApiChartSeries>(() => api.charts.dexVolume());
  const assets    = useOneShot<ApiChartSeries>(() => api.charts.assets());

  const [timeframe, setTimeframe] = useState<Timeframe>('ALL');

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
        <ChartCell state={hashrate}  title="Hashrate (Beamhash III) [MSol/s]" timeframe={timeframe} scale={1 / 1e6} formatter={fmtMSol} />
        <ChartCell state={kernels}   title="Kernels / day"                    timeframe={timeframe} formatter={fmtInt} />
        <ChartCell state={dexVolume} title="DEX volume / day"                 timeframe={timeframe} formatter={fmtUsd} />
        <ChartCell state={assets}    title="Confidential Assets"              timeframe={timeframe} formatter={fmtInt} />
      </Grid>
    </Page>
  );
};

export default NetworkCharts;
