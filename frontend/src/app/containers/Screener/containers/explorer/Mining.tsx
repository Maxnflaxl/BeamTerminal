import React, { useEffect, useRef, useState, useMemo } from 'react';
import { styled } from '@linaria/react';
import {
  createChart, ColorType,
  type IChartApi, type ISeriesApi, type LineData, type UTCTimestamp,
} from 'lightweight-charts';
import { api } from '../../api/client';
import type { ApiMiningPools, ApiMiningPool, ApiMiningBlocks } from '../../api/types';
import type { ApiChartPoint } from '../../api/client';
import { Sparkline } from '../../components/Sparkline';
import {
  Page, Card, H2, H3,
  DataTable, TabBtn, Dot, Btn, Muted, theme,
} from './shared';

// --- helpers -----------------------------------------------------------------

function fmtHashrate(solPerSec: number | null): string {
  if (solPerSec == null || !Number.isFinite(solPerSec)) return '—';
  const units = ['Sol/s', 'KSol/s', 'MSol/s', 'GSol/s'];
  let v = solPerSec;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  return `${v.toFixed(2)} ${units[i]}`;
}

function fmtAge(iso: string | null): string {
  if (!iso) return '—';
  const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 90) return `${Math.round(secs)}s ago`;
  if (secs < 5400) return `${Math.round(secs / 60)}m ago`;
  if (secs < 129600) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

const COLORS = ['#00f6d2', '#4f9dff', '#ffb454', '#ff6b9d', '#a78bfa', '#34d399', '#f87171', '#94a3b8'];

// --- Donut -------------------------------------------------------------------

interface Slice { label: string; value: number; color: string }

const Donut: React.FC<{ slices: Slice[]; size?: number }> = ({ slices, size = 180 }) => {
  const total = slices.reduce((s, x) => s + x.value, 0) || 1;
  const r = size / 2;
  const stroke = size * 0.18;
  const radius = r - stroke / 2;
  const circ = 2 * Math.PI * radius;
  let offset = 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <g transform={`rotate(-90 ${r} ${r})`}>
        {slices.map((s, i) => {
          const frac = s.value / total;
          const len = frac * circ;
          const el = (
            <circle
              key={i}
              cx={r} cy={r} r={radius}
              fill="none" stroke={s.color} strokeWidth={stroke}
              strokeDasharray={`${len} ${circ - len}`}
              strokeDashoffset={-offset}
            />
          );
          offset += len;
          return el;
        })}
      </g>
    </svg>
  );
};

// --- styled helpers ----------------------------------------------------------

const TabRow = styled.div`
  display: -webkit-box;
  display: flex;
  -webkit-box-align: center;
  align-items: center;
  margin-bottom: 14px;
  > * + * { margin-left: 8px; }
`;

const HeaderStrip = styled.div`
  display: -webkit-box;
  display: flex;
  -webkit-box-align: center;
  align-items: center;
  -webkit-box-pack: justify;
  justify-content: space-between;
  flex-wrap: wrap;
  margin-bottom: 12px;
  > * + * { margin-top: 0; }
`;

const NetInfo = styled.span`
  font-size: 12px;
  color: ${theme.color.muted};
  > strong { color: ${theme.color.text}; }
`;

const ChartWrap = styled.div`
  height: 320px;
  background: ${theme.color.surface2};
  border-radius: ${theme.radius.md};
  overflow: hidden;
`;

const DonutLayout = styled.div`
  display: grid;
  grid-template-columns: 190px 1fr;
  gap: 24px;
  align-items: center;
  @media (max-width: 600px) { grid-template-columns: 1fr; }
`;

const Legend = styled.ul`
  list-style: none; margin: 0; padding: 0;
  li {
    display: -webkit-box;
    display: flex;
    -webkit-box-align: center;
    align-items: center;
    padding: 5px 0;
    font-size: 13px;
    > * + * { margin-left: 8px; }
  }
  li .swatch { width: 10px; height: 10px; border-radius: 2px; display: inline-block; flex-shrink: 0; }
  li .pct { margin-left: auto; opacity: 0.65; font-size: 12px; }
  li .cnt { opacity: 0.8; font-size: 12px; }
`;

const ModalOverlay = styled.div`
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(4, 37, 72, 0.82);
  z-index: 200;
  display: -webkit-box;
  display: flex;
  -webkit-box-align: center;
  align-items: center;
  -webkit-box-pack: center;
  justify-content: center;
`;

const ModalCard = styled.div`
  background: #061f3c;
  border: 1px solid ${theme.color.border};
  border-radius: ${theme.radius.lg};
  padding: 24px;
  min-width: 280px;
  max-width: 480px;
  width: 90%;
`;

const ModalHeader = styled.div`
  display: -webkit-box;
  display: flex;
  -webkit-box-align: center;
  align-items: center;
  -webkit-box-pack: justify;
  justify-content: space-between;
  margin-bottom: 16px;
`;

const CloseBtn = styled.button`
  background: transparent;
  border: none;
  color: ${theme.color.muted};
  font-size: 18px;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
  &:hover { color: ${theme.color.text}; }
`;

const SparkCell = styled.div`
  display: -webkit-box;
  display: flex;
  -webkit-box-align: center;
  align-items: center;
  > * + * { margin-left: 8px; }
`;

// --- component ---------------------------------------------------------------

type Tab = 'blocks' | 'diffprice' | 'hashrate';

export const Mining: React.FC = () => {
  const [poolData, setPoolData] = useState<ApiMiningPools | null>(null);
  const [blockData, setBlockData] = useState<ApiMiningBlocks | null>(null);
  const [poolErr, setPoolErr] = useState<string | null>(null);
  const [blocksLoaded, setBlocksLoaded] = useState(false);
  const [blocksError, setBlocksError] = useState(false);
  const [tab, setTab] = useState<Tab>('blocks');
  const [calcOpen, setCalcOpen] = useState(false);

  // chart data for diffprice / hashrate tabs
  const [diffSeries, setDiffSeries]     = useState<ApiChartPoint[]>([]);
  const [priceSeries, setPriceSeries]   = useState<ApiChartPoint[]>([]);
  const [hashSeries, setHashSeries]     = useState<ApiChartPoint[]>([]);

  const chartWrapRef = useRef<HTMLDivElement>(null);
  const chartRef     = useRef<IChartApi | null>(null);

  // --- polling ---------------------------------------------------------------
  useEffect(() => {
    let alive = true;
    const load = () => {
      api.miningPools()
        .then((d) => { if (alive) { setPoolData(d); setPoolErr(null); } })
        .catch((e: Error) => { if (alive) setPoolErr(e?.message ?? 'failed to load'); });
      api.miningBlocks(50)
        .then((d) => { if (alive) { setBlockData(d); setBlocksLoaded(true); setBlocksError(false); } })
        .catch(() => { if (alive) { setBlocksLoaded(true); setBlocksError(true); } });
    };
    load();
    const t = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  // --- fetch chart series lazily when tab changes ---------------------------
  useEffect(() => {
    let alive = true;
    if (tab === 'diffprice') {
      Promise.all([api.charts.difficulty(), api.charts.price()]).then(([d, p]) => {
        if (!alive) return;
        setDiffSeries(d.series ?? []);
        setPriceSeries(p.series ?? []);
      }).catch(() => {});
    } else if (tab === 'hashrate') {
      api.charts.hashrate().then((d) => {
        if (!alive) return;
        setHashSeries(d.series ?? []);
      }).catch(() => {});
    }
    return () => { alive = false; };
  }, [tab]);

  // --- lightweight-charts: rebuild when tab or data changes -----------------
  useEffect(() => {
    const el = chartWrapRef.current;
    if (!el) return;
    // destroy previous
    if (chartRef.current) { chartRef.current.remove(); chartRef.current = null; }

    if (tab === 'blocks') return; // SVG tab — no LWC chart

    const hasDiff  = tab === 'diffprice' && diffSeries.length > 0;
    const hasPrice = tab === 'diffprice' && priceSeries.length > 0;
    const hasHash  = tab === 'hashrate'  && hashSeries.length > 0;

    if (!hasDiff && !hasPrice && !hasHash) return; // no data yet

    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'rgba(255,255,255,0.03)' },
        textColor: 'rgba(255, 255, 255, 0.6)',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(255, 255, 255, 0.04)' },
        horzLines: { color: 'rgba(255, 255, 255, 0.04)' },
      },
      rightPriceScale: { borderColor: 'rgba(255, 255, 255, 0.1)', visible: true },
      leftPriceScale:  { borderColor: 'rgba(255, 255, 255, 0.1)', visible: tab === 'diffprice' },
      timeScale: { borderColor: 'rgba(255, 255, 255, 0.1)', timeVisible: false },
    });
    chartRef.current = chart;

    const toLineData = (pts: ApiChartPoint[]): LineData[] =>
      pts.map((p) => ({ time: p.ts as UTCTimestamp, value: p.value }));

    if (tab === 'diffprice') {
      if (hasDiff) {
        const s: ISeriesApi<'Line'> = chart.addLineSeries({
          color: '#4f9dff', lineWidth: 2, priceLineVisible: false, lastValueVisible: false, priceScaleId: 'left',
        });
        s.setData(toLineData(diffSeries));
      }
      if (hasPrice) {
        const s: ISeriesApi<'Line'> = chart.addLineSeries({
          color: '#00f6d2', lineWidth: 2, priceLineVisible: false, lastValueVisible: false, priceScaleId: 'right',
        });
        s.setData(toLineData(priceSeries));
      }
    } else if (tab === 'hashrate' && hasHash) {
      const s: ISeriesApi<'Line'> = chart.addLineSeries({
        color: '#ffb454', lineWidth: 2, priceLineVisible: false, lastValueVisible: false,
      });
      s.setData(toLineData(hashSeries));
    }

    chart.timeScale().fitContent();

    return () => {
      if (chartRef.current) { chartRef.current.remove(); chartRef.current = null; }
    };
  }, [tab, diffSeries, priceSeries, hashSeries]);

  // --- derived data ----------------------------------------------------------
  const network  = poolData?.network_hashrate ?? null;
  const blockHt  = poolData?.block_height ?? null;
  const pools    = poolData?.pools ?? [];
  const blocks   = blockData?.blocks ?? [];

  const sorted = useMemo(
    () => [...pools].sort((a, b) => (b.hashrate ?? -1) - (a.hashrate ?? -1)),
    [pools],
  );

  // pool name → website map for recent-blocks attribution
  const poolByName = useMemo(() => {
    const m: Record<string, string> = {};
    for (const p of pools) { m[p.name] = p.website; }
    return m;
  }, [pools]);

  // blocks distribution slices
  const blockSlices: Slice[] = useMemo(() => {
    const known = sorted.filter((p) => (p.blocks_last_100 ?? 0) > 0);
    const sum = known.reduce((s, p) => s + (p.blocks_last_100 ?? 0), 0);
    const out: Slice[] = known.map((p, i) => ({
      label: p.name, value: p.blocks_last_100 ?? 0, color: COLORS[i % COLORS.length],
    }));
    const unknown = Math.max(0, 100 - sum);
    if (unknown > 0) out.push({ label: 'Unknown', value: unknown, color: COLORS[7] });
    return out;
  }, [sorted]);
  const blockSliceTotal = blockSlices.reduce((s, x) => s + x.value, 0) || 1;

  // --- render ----------------------------------------------------------------
  return (
    <Page>
      <H2>Mining</H2>

      {/* ── 1. Pool list ─────────────────────────────────────────────────── */}
      <Card>
        <HeaderStrip>
          <H2 style={{ margin: 0 }}>Pools</H2>
          <NetInfo>
            Network hashrate: <strong>{fmtHashrate(network)}</strong>
            {blockHt != null && (
              <span style={{ marginLeft: 12 }}>Block: <strong>{blockHt.toLocaleString()}</strong></span>
            )}
          </NetInfo>
        </HeaderStrip>
        {poolErr && <Muted>Could not load pool data: {poolErr}</Muted>}
        {sorted.length === 0 && !poolErr && <Muted>Loading pool data…</Muted>}
        {sorted.length > 0 && (
          <DataTable>
            <thead>
              <tr>
                <th style={{ width: 32 }}>#</th>
                <th>Pool</th>
                <th>Fee</th>
                <th>Hashrate</th>
                <th className="right">Blocks / 100</th>
                <th className="right">Block Height</th>
                <th className="right">Last Found</th>
                <th style={{ width: 20 }}></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((p: ApiMiningPool, idx) => {
                const offline = p.hashrate == null;
                return (
                  <tr key={p.id} style={{ opacity: offline ? 0.55 : 1 }}>
                    <td className="muted">{idx + 1}</td>
                    <td>
                      <div>
                        <a href={p.website} target="_blank" rel="noreferrer">{p.name}</a>
                      </div>
                      {p.payout_scheme && (
                        <div style={{ fontSize: 11, color: theme.color.muted, marginTop: 2 }}>
                          {p.payout_scheme}{p.fee != null ? ` · ${p.fee}%` : ''}
                        </div>
                      )}
                    </td>
                    <td>{p.fee != null ? `${p.fee}%` : '—'}</td>
                    <td>
                      <SparkCell>
                        <span>{fmtHashrate(p.hashrate)}</span>
                        {(p.hashrate_series ?? []).length > 0 && (
                          <Sparkline values={p.hashrate_series ?? []} width={80} height={24} />
                        )}
                      </SparkCell>
                    </td>
                    <td className="right">{p.blocks_last_100 ?? '—'}</td>
                    <td className="right">{blockHt != null ? blockHt.toLocaleString() : '—'}</td>
                    <td className="right">{fmtAge(p.last_block_ts)}</td>
                    <td><Dot data-kind={offline ? 'error' : 'live'} /></td>
                  </tr>
                );
              })}
            </tbody>
          </DataTable>
        )}
      </Card>

      {/* ── 2. Tabbed chart panel ────────────────────────────────────────── */}
      <Card>
        <TabRow>
          {(['blocks', 'diffprice', 'hashrate'] as Tab[]).map((t) => (
            <TabBtn key={t} data-active={String(tab === t)} onClick={() => setTab(t)}>
              {t === 'blocks' ? 'Blocks' : t === 'diffprice' ? 'Diff / Price' : 'Hashrate'}
            </TabBtn>
          ))}
        </TabRow>

        {tab === 'blocks' && (
          blockSlices.length === 0
            ? <Muted>No block attribution data available yet.</Muted>
            : (
              <DonutLayout>
                <Donut slices={blockSlices} size={180} />
                <Legend>
                  {blockSlices.map((s, i) => (
                    <li key={i}>
                      <span className="swatch" style={{ background: s.color }} />
                      <span>{s.label}</span>
                      <span className="cnt">{s.value}</span>
                      <span className="pct">{((s.value / blockSliceTotal) * 100).toFixed(1)}%</span>
                    </li>
                  ))}
                </Legend>
              </DonutLayout>
            )
        )}

        {tab !== 'blocks' && (
          <>
            {tab === 'diffprice' && diffSeries.length === 0 && priceSeries.length === 0 && (
              <Muted>Loading chart data…</Muted>
            )}
            {tab === 'hashrate' && hashSeries.length === 0 && (
              <Muted>Loading chart data…</Muted>
            )}
            <ChartWrap ref={chartWrapRef} />
            {tab === 'diffprice' && (diffSeries.length > 0 || priceSeries.length > 0) && (
              <div style={{ marginTop: 8, fontSize: 11, color: theme.color.muted }}>
                <span style={{ color: '#4f9dff', marginRight: 4 }}>&#9644;</span> Difficulty (left)
                <span style={{ marginLeft: 16, color: '#00f6d2', marginRight: 4 }}>&#9644;</span> Price USD (right)
              </div>
            )}
          </>
        )}
      </Card>

      {/* ── 3. Recent blocks ─────────────────────────────────────────────── */}
      <Card>
        <H2>Recent Blocks</H2>
        {!blocksLoaded && <Muted>Loading recent blocks…</Muted>}
        {blocksLoaded && (blocksError || blocks.length === 0)
          ? <Muted>Recent blocks unavailable.</Muted>
          : blocksLoaded && (
            <DataTable>
              <thead>
                <tr>
                  <th>Block</th>
                  <th>Mined by</th>
                  <th className="right">Age</th>
                </tr>
              </thead>
              <tbody>
                {blocks.map((b) => {
                  const site = b.mined_by ? (poolByName[b.mined_by] ?? null) : null;
                  return (
                    <tr key={b.height}>
                      <td className="mono">{b.height.toLocaleString()}</td>
                      <td>
                        {b.mined_by
                          ? site
                            ? <a href={site} target="_blank" rel="noreferrer">{b.mined_by}</a>
                            : b.mined_by
                          : <span className="muted">—</span>}
                      </td>
                      <td className="right">{fmtAge(b.ts)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </DataTable>
          )}
      </Card>

      {/* ── 4. Calculator modal ──────────────────────────────────────────── */}
      <div style={{ marginBottom: 16 }}>
        <Btn type="button" onClick={() => setCalcOpen(true)}>Open mining calculator</Btn>
      </div>

      {calcOpen && (
        <ModalOverlay onClick={() => setCalcOpen(false)}>
          <ModalCard onClick={(e) => e.stopPropagation()}>
            <ModalHeader>
              <H3 style={{ margin: 0 }}>Mining Calculator</H3>
              <CloseBtn type="button" onClick={() => setCalcOpen(false)} aria-label="Close">&#x2715;</CloseBtn>
            </ModalHeader>
            <Muted>Mining calculator coming soon.</Muted>
          </ModalCard>
        </ModalOverlay>
      )}
    </Page>
  );
};
