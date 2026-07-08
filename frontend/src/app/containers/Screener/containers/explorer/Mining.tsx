import React, { useEffect, useRef, useState, useMemo } from 'react';
import { styled } from '@linaria/react';
import { css } from '@linaria/core';
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
  DataTable, TabBtn, Dot, Btn, Muted, theme, fmtHashrate, Donut,
} from './shared';
import { MiningCalculator } from './MiningCalculator';

// --- helpers -----------------------------------------------------------------

function fmtSI(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (Math.abs(v) >= 1e9) return (v / 1e9).toFixed(1) + 'G';
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return v.toFixed(0);
}

function fmtAge(iso: string | null): string {
  if (!iso) return '—';
  const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 90) return `${Math.round(secs)}s ago`;
  if (secs < 5400) return `${Math.round(secs / 60)}m ago`;
  if (secs < 129600) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

// Block solve-time bar: width grows with the interval (full at ~5× target),
// red once a block took noticeably longer than BEAM's ~60s target.
const BLOCK_TARGET_SECS = 60;
function ageBar(intervalSecs: number | null): { pct: number; color: string } | null {
  if (intervalSecs == null || intervalSecs < 0) return null;
  const pct = Math.max(6, Math.min(100, (intervalSecs / (BLOCK_TARGET_SECS * 5)) * 100));
  const color = intervalSecs > BLOCK_TARGET_SECS * 2 ? '#f87171' : '#4f9dff';
  return { pct, color };
}

const COLORS = ['#00f6d2', '#4f9dff', '#ffb454', '#ff6b9d', '#a78bfa', '#34d399', '#f87171', '#94a3b8'];

// --- Donut -------------------------------------------------------------------

interface Slice { label: string; value: number; color: string }

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
  max-width: 1040px;
  width: 94vw;
  max-height: 90vh;
  overflow-y: auto;
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

const HashrateBarTrack = styled.div`
  width: 100%;
  height: 4px;
  background: rgba(255,255,255,0.08);
  border-radius: 2px;
  margin-top: 4px;
`;

const HashrateBarFill = styled.div<{ width: string }>`
  height: 4px;
  background: #f0a500;
  border-radius: 2px;
  width: ${(props) => props.width};
`;

const SparkTooltip = styled.div`
  position: absolute;
  background: #061f3c;
  border: 1px solid ${theme.color.border};
  border-radius: 4px;
  padding: 6px 8px;
  font-size: 11px;
  color: ${theme.color.text};
  pointer-events: none;
  z-index: 10;
  white-space: nowrap;
  line-height: 1.5;
`;

function fmtTooltipDate(ts: number): string {
  const d = new Date(ts * 1000);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dow = days[d.getDay()];
  const mon = months[d.getMonth()];
  const day = d.getDate();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${dow}, ${mon} ${day} ${hh}:${mm}`;
}

interface HashrateSeriesPoint { ts: number; value: number }

const HashrateCell: React.FC<{
  series: HashrateSeriesPoint[];
  hashrate: number | null;
  barWidth: string;
}> = ({ series, hashrate, barWidth }) => {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const avg = useMemo(() => {
    if (!series.length) return 0;
    return series.reduce((s, p) => s + p.value, 0) / series.length;
  }, [series]);

  const values = useMemo(() => series.map((s) => s.value), [series]);

  const SPARK_W = 80;
  const SPARK_H = 24;

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!series.length || !wrapRef.current) return;
    const rect = wrapRef.current.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const raw = series.length > 1 ? (mouseX / rect.width) * (series.length - 1) : 0;
    setHoverIdx(Math.max(0, Math.min(series.length - 1, Math.round(raw))));
  };

  const handleMouseLeave = () => setHoverIdx(null);

  // X of the snapped data point within the sparkline.
  const pointX = hoverIdx != null && series.length > 1
    ? (hoverIdx / (series.length - 1)) * SPARK_W
    : 0;
  // Anchor the tooltip to the point: extend left when the point is in the
  // right half, right otherwise — keeps it near and on-screen.
  const rightHalf = pointX > SPARK_W / 2;

  return (
    <div>
      <SparkCell>
        <span>{fmtHashrate(hashrate)}</span>
        {values.length > 0 && (
          <div
            ref={wrapRef}
            style={{ position: 'relative', display: 'inline-block', width: SPARK_W, height: SPARK_H }}
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
          >
            <Sparkline values={values} width={SPARK_W} height={SPARK_H} />
            {hoverIdx != null && series[hoverIdx] && (
              <>
                <div
                  style={{
                    position: 'absolute', left: pointX, top: 0,
                    width: 1, height: SPARK_H, background: '#f0a500',
                    pointerEvents: 'none',
                  }}
                />
                <SparkTooltip
                  style={rightHalf
                    ? { right: SPARK_W - pointX, bottom: SPARK_H + 6 }
                    : { left: pointX, bottom: SPARK_H + 6 }}
                >
                  <div>{fmtTooltipDate(series[hoverIdx].ts)}</div>
                  <div>Hashrate: {fmtHashrate(series[hoverIdx].value)}</div>
                  <div>Average: {fmtHashrate(avg)}</div>
                </SparkTooltip>
              </>
            )}
          </div>
        )}
      </SparkCell>
      <HashrateBarTrack>
        <HashrateBarFill width={barWidth} />
      </HashrateBarTrack>
    </div>
  );
};

// Age cell for the Recent Blocks table: the age text + solve-time bar, plus a
// hover tooltip revealing the block time (seconds since the previous block).
const AgeCell: React.FC<{ iso: string | null; interval: number | null }> = ({ iso, interval }) => {
  const [hover, setHover] = useState(false);
  const bar = ageBar(interval);
  return (
    <div
      style={{ position: 'relative', display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <span>{fmtAge(iso)}</span>
      {bar && (
        <div style={{ width: 64, height: 3, borderRadius: 2, background: 'rgba(148,163,184,0.18)' }}>
          <div style={{ width: `${bar.pct}%`, height: '100%', borderRadius: 2, background: bar.color }} />
        </div>
      )}
      {/* Anchored to the age+bar box (inline-flex): vertically centered on the row,
          and `right: 100%` places it left of the solve-time bar so it never covers it. */}
      {hover && interval != null && interval >= 0 && (
        <SparkTooltip style={{ right: '100%', top: '50%', transform: 'translateY(-50%)', marginRight: 10 }}>
          Block time: {Math.round(interval)} s
        </SparkTooltip>
      )}
    </div>
  );
};

const pagerCss = css`
  display: -webkit-box;
  display: flex;
  -webkit-box-align: center;
  align-items: center;
  -webkit-box-pack: center;
  justify-content: center;
  margin-top: 14px;
  > * + * { margin-left: 12px; }
`;

// --- component ---------------------------------------------------------------

type Tab = 'blocks' | 'diffprice' | 'hashrate';

export const Mining: React.FC = () => {
  const BLOCKS_PER_PAGE = 25;
  const [poolData, setPoolData] = useState<ApiMiningPools | null>(null);
  const [blockData, setBlockData] = useState<ApiMiningBlocks | null>(null);
  const [poolErr, setPoolErr] = useState<string | null>(null);
  const [blocksLoaded, setBlocksLoaded] = useState(false);
  const [blocksError, setBlocksError] = useState(false);
  const [blockPage, setBlockPage] = useState(0);
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
      api.miningBlocks(BLOCKS_PER_PAGE, blockPage * BLOCKS_PER_PAGE)
        .then((d) => { if (alive) { setBlockData(d); setBlocksLoaded(true); setBlocksError(false); } })
        .catch(() => { if (alive) { setBlocksLoaded(true); setBlocksError(true); } });
    };
    load();
    const t = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, [blockPage]); // eslint-disable-line react-hooks/exhaustive-deps

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
          priceFormat: { type: 'custom', minMove: 1, formatter: (p: number) => fmtSI(p) },
        });
        s.setData(toLineData(diffSeries));
      }
      if (hasPrice) {
        const s: ISeriesApi<'Line'> = chart.addLineSeries({
          color: '#00f6d2', lineWidth: 2, priceLineVisible: false, lastValueVisible: false, priceScaleId: 'right',
          priceFormat: { type: 'custom', minMove: 0.0001, formatter: (p: number) => '$' + p.toFixed(p < 1 ? 4 : 2) },
        });
        s.setData(toLineData(priceSeries));
      }
    } else if (tab === 'hashrate' && hasHash) {
      const s: ISeriesApi<'Line'> = chart.addLineSeries({
        color: '#ffb454', lineWidth: 2, priceLineVisible: false, lastValueVisible: false,
        priceFormat: { type: 'custom', minMove: 1, formatter: (p: number) => fmtHashrate(p) },
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
  const hasNext  = blocks.length === BLOCKS_PER_PAGE;

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

  // summary totals across pools (only pools that report a count)
  const totalMiners = useMemo(() => {
    const vals = pools.map((p) => p.miners).filter((n): n is number => n != null);
    return vals.length ? vals.reduce((s, n) => s + n, 0) : null;
  }, [pools]);
  const totalWorkers = useMemo(() => {
    const vals = pools.map((p) => p.workers).filter((n): n is number => n != null);
    return vals.length ? vals.reduce((s, n) => s + n, 0) : null;
  }, [pools]);

  // max hashrate for proportional bar
  const maxHashrate = useMemo(
    () => Math.max(1, ...pools.map((p) => p.hashrate ?? 0)),
    [pools],
  );

  // blocks distribution slices — over the last 1000 network blocks
  const blockSlices: Slice[] = useMemo(() => {
    const known = sorted.filter((p) => (p.blocks_last_1000 ?? 0) > 0);
    const sum = known.reduce((s, p) => s + (p.blocks_last_1000 ?? 0), 0);
    const out: Slice[] = known.map((p, i) => ({
      label: p.name, value: p.blocks_last_1000 ?? 0, color: COLORS[i % COLORS.length],
    }));
    const unknown = Math.max(0, 1000 - sum);
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
            {totalMiners != null && (
              <span style={{ marginLeft: 12 }}>Miners: <strong>{totalMiners.toLocaleString()}</strong></span>
            )}
            {totalWorkers != null && (
              <span style={{ marginLeft: 12 }}>Workers: <strong>{totalWorkers.toLocaleString()}</strong></span>
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
                <th>Hashrate</th>
                <th className="right">Miners</th>
                <th className="right">Workers</th>
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
                          {p.fee != null ? `${p.fee}% ` : ''}{p.payout_scheme}
                        </div>
                      )}
                    </td>
                    <td style={{ position: 'relative' }}>
                      <HashrateCell
                        series={p.hashrate_series ?? []}
                        hashrate={p.hashrate}
                        barWidth={`${((p.hashrate ?? 0) / maxHashrate) * 100}%`}
                      />
                    </td>
                    <td className="right">{p.miners != null ? p.miners.toLocaleString() : '—'}</td>
                    <td className="right">{p.workers != null ? p.workers.toLocaleString() : '—'}</td>
                    <td className="right">{p.blocks_last_100 ?? '—'}</td>
                    <td className="right">{p.last_block_height != null ? p.last_block_height.toLocaleString() : '—'}</td>
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
                <Donut
                  slices={blockSlices.map((s, i) => ({ key: String(i), label: s.label, color: s.color, value: s.value }))}
                  size={180}
                  idlePrimary={blockSliceTotal}
                  idleSecondary="blocks"
                />
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
            <>
              <DataTable>
                <thead>
                  <tr>
                    <th>Block</th>
                    <th>Mined by</th>
                    <th className="right">Age</th>
                  </tr>
                </thead>
                <tbody>
                  {blocks.map((b, i) => {
                    const site = b.mined_by ? (poolByName[b.mined_by] ?? null) : null;
                    // Block solve time = gap to the next-older block in the list.
                    const older = blocks[i + 1];
                    const interval = older
                      ? (new Date(b.ts).getTime() - new Date(older.ts).getTime()) / 1000
                      : null;
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
                        <td className="right">
                          <AgeCell iso={b.ts} interval={interval} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </DataTable>
              <div className={pagerCss}>
                <Btn type="button" disabled={blockPage === 0}
                     onClick={() => setBlockPage((p) => Math.max(0, p - 1))}>&#8592; Newer</Btn>
                <span>Page {blockPage + 1}</span>
                <Btn type="button" disabled={!hasNext}
                     onClick={() => setBlockPage((p) => p + 1)}>Older &#8594;</Btn>
              </div>
            </>
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
            <MiningCalculator />
          </ModalCard>
        </ModalOverlay>
      )}
    </Page>
  );
};
