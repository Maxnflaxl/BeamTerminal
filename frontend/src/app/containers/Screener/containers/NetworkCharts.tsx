import React, { useEffect, useState } from 'react';
import { styled } from '@linaria/react';
import { api, type ApiChartSeries } from '../api/client';
import { SimpleChart } from '../components/SimpleChart';

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

export const NetworkCharts: React.FC = () => {
  const hashrate  = useOneShot<ApiChartSeries>(() => api.charts.hashrate());
  const kernels   = useOneShot<ApiChartSeries>(() => api.charts.kernels());
  const dexVolume = useOneShot<ApiChartSeries>(() => api.charts.dexVolume());
  const assets    = useOneShot<ApiChartSeries>(() => api.charts.assets());

  const renderCell = (
    state: { data: ApiChartSeries | null; loading: boolean; error: string | null },
    title: string,
    extra: { scale?: number; formatter?: (v: number) => string } = {},
  ) => (
    <Cell>
      {state.data ? (
        <SimpleChart
          series={state.data.series}
          title={title}
          scale={extra.scale}
          formatter={extra.formatter}
        />
      ) : (
        <Loading>{state.error ?? (state.loading ? 'Loading…' : 'No data')}</Loading>
      )}
    </Cell>
  );

  return (
    <Page>
      <Grid>
        {renderCell(hashrate,  'Hashrate (Beamhash III) [MSol/s]', { scale: 1 / 1e6, formatter: fmtMSol })}
        {renderCell(kernels,   'Kernels / day',                    { formatter: fmtInt })}
        {renderCell(dexVolume, 'DEX volume / day',                 { formatter: fmtUsd })}
        {renderCell(assets,    'Confidential Assets',              { formatter: fmtInt })}
      </Grid>
    </Page>
  );
};

export default NetworkCharts;
