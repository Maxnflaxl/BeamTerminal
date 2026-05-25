import React, { useEffect, useRef, useState, useCallback } from 'react';
import { styled } from '@linaria/react';
import {
  createChart, ColorType, LineStyle,
} from 'lightweight-charts';
import type {
  IChartApi, ISeriesApi, LineData, UTCTimestamp,
} from 'lightweight-charts';
import {
  Page, ExplorerHeader, H1, Subtitle, Label, Dot,
  Btn, Input, NodeSelector, StatGrid, StatCard, ErrorBox, theme,
} from './shared';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const REFRESH_INTERVAL_MS = 30_000;
const UNIQUE_BLOCKS_NEEDED = 60;

const NODE_OPTIONS: { label: string; url: string }[] = [
  { label: 'explorer.0xmx.net', url: 'https://explorer.0xmx.net/api' },
  { label: 'explorer-api.beamprivacy.com', url: 'https://explorer-api.beamprivacy.com' },
  { label: 'explorer.beam.mw (official)', url: 'https://explorer.beam.mw/api' },
];

const NODE_SELECT_OPTIONS = [
  ...NODE_OPTIONS.map((o) => ({ value: o.url, label: o.label })),
  { value: 'custom', label: 'Custom node…' },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Kernel { fee?: number }

interface BlockData {
  height?: number;
  h?: number;
  hash?: string;
  timestamp: number;
  difficulty?: number;
  kernels?: Kernel[];
  rate_usd?: string | number;
  rate_btc?: string | number;
  found?: boolean;
}

interface StatusData {
  height: number;
  hash?: string;
  peers_count?: number;
  shielded_outputs_total?: number;
  shielded_outputs_per_24h?: number;
  shielded_possible_ready_in_hours?: string | number;
}

interface HdrsResponse {
  value?: unknown[];
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function fmt(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(0);
}

function fmtDifficulty(diff: number): string {
  if (diff >= 1e9) return `${(diff / 1e9).toFixed(2)}G`;
  if (diff >= 1e6) return `${(diff / 1e6).toFixed(2)}M`;
  if (diff >= 1e3) return `${(diff / 1e3).toFixed(2)}K`;
  return diff.toFixed(2);
}

function diffToHashrate(diff: number, blockTimeSecs: number): number {
  return diff / blockTimeSecs;
}

function fmtBeamSolutionsPerSec(solPerSec: number): { val: string; unit: string } {
  const ks = solPerSec / 1e3;
  if (ks >= 1e6) return { val: (ks / 1e6).toFixed(2), unit: 'MS/s' };
  if (ks >= 1e3) return { val: (ks / 1e3).toFixed(2), unit: 'GS/s' };
  return { val: ks.toFixed(2), unit: 'KS/s' };
}

function getHeight(b: BlockData): number {
  return (b.height ?? b.h ?? 0);
}

// Δ cumulative T.Txs across 1440 blocks (~24h at 60s target).
function parseTxs24hFromHdrs(data: HdrsResponse | null): number | null {
  if (!data || !Array.isArray(data.value) || data.value.length < 3) return null;
  const parseCell = (cell: unknown): number => {
    if (typeof cell === 'string') return parseInt(cell.replace(/,/g, ''), 10);
    return NaN;
  };
  const row1 = data.value[1] as unknown[];
  const row2 = data.value[2] as unknown[];
  if (!Array.isArray(row1) || !Array.isArray(row2)) return null;
  const hi = parseCell(row1[row1.length - 1]);
  const lo = parseCell(row2[row2.length - 1]);
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null;
  return Math.max(0, hi - lo);
}

// ---------------------------------------------------------------------------
// Page-specific styled (unique presentation only — colors via theme.color.*)
// ---------------------------------------------------------------------------

const HeaderRight = styled.div`
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
`;

const TitleBlock = styled.div`
  display: flex;
  flex-direction: column;
`;

const StatusRow = styled.div`
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 11px;
  color: ${theme.color.muted};
  letter-spacing: 0.05em;
`;

const CustomNodeRow = styled.div`
  display: flex;
  gap: 6px;
  & input { width: 220px; font-size: 11px; padding: 5px 10px; }
  & button { font-size: 11px; padding: 5px 10px; }
`;

const PriceBar = styled.div`
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 12px 18px;
  background: ${theme.color.surface2};
  border: 1px solid ${theme.color.borderDim};
  border-radius: 10px;
  margin-bottom: 16px;
  flex-wrap: wrap;
`;

const PriceLabel = styled.span`
  color: ${theme.color.muted};
  font-size: 11px;
`;

const PriceUsd = styled.span`
  font-size: 20px;
  font-weight: 700;
  color: ${theme.color.text};
`;

const PriceBtc = styled.span`
  color: ${theme.color.warn};
  font-size: 12px;
`;

const PriceSep = styled.span`
  color: rgba(255, 255, 255, 0.1);
`;

const NetworkName = styled.span`
  color: ${theme.color.text};
  font-size: 12px;
`;

const StatCardAccentBar = styled.div`
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 2px;
  background: linear-gradient(90deg, transparent, ${theme.color.accent}, transparent);
  opacity: 0.6;
  pointer-events: none;
`;

const StatValue = styled.div<{ tone?: 'accent' | 'normal' | 'amber' | 'loading' }>`
  font-size: ${(p) => (p.tone === 'loading' ? '20px' : p.tone === 'normal' ? '24px' : '28px')};
  font-weight: 700;
  line-height: 1;
  letter-spacing: -0.02em;
  color: ${(p) => {
    if (p.tone === 'amber') return theme.color.warn;
    if (p.tone === 'normal') return theme.color.text;
    if (p.tone === 'loading') return theme.color.muted;
    return theme.color.accent;
  }};
  animation: ${(p) => (p.tone === 'loading' ? 'health-blink 1.2s step-end infinite' : 'none')};
  @keyframes health-blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }
`;

const StatSub = styled.div`
  font-size: 11px;
  color: ${theme.color.muted};
  margin-top: 6px;
  word-break: break-all;
`;

const SectionLabel = styled.div`
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: ${theme.color.muted};
  margin: 24px 0 12px;
  display: flex;
  align-items: center;
  gap: 12px;
  &::after {
    content: '';
    flex: 1;
    height: 1px;
    background: ${theme.color.borderDim};
  }
`;

const Grid2 = styled.div`
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-bottom: 16px;
  @media (max-width: 860px) { grid-template-columns: 1fr; }
`;

const Panel = styled.div`
  background: ${theme.color.surface};
  border: 1px solid ${theme.color.borderDim};
  border-radius: 12px;
  overflow: hidden;
`;

const PanelHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid ${theme.color.borderDim};
`;

const PanelTitle = styled.div`
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: ${theme.color.muted};
  display: flex;
  align-items: center;
  gap: 8px;
  &::before {
    content: '';
    width: 6px;
    height: 6px;
    border-radius: 1px;
    background: ${theme.color.accent};
    opacity: 0.7;
  }
`;

const PanelAside = styled.span`
  font-size: 10px;
  color: ${theme.color.muted};
`;

const PanelBody = styled.div`
  padding: 18px;
`;

const ChartHost = styled.div`
  width: 100%;
  height: 160px;
`;

const BlockTimeWrap = styled.div`
  position: relative;
  height: 100px;
`;

const BlockTimeBars = styled.div`
  display: flex;
  align-items: flex-end;
  gap: 3px;
  height: 100px;
`;

const BtBar = styled.div<{ color: string; barHeight: number }>`
  flex: 1;
  border-radius: 2px 2px 0 0;
  min-height: 2px;
  background: ${(p) => p.color};
  height: ${(p) => p.barHeight}px;
  opacity: 0.75;
  position: relative;
  cursor: default;
  &:hover::after {
    content: attr(data-tip);
    position: absolute;
    bottom: calc(100% + 6px);
    left: 50%;
    transform: translateX(-50%);
    background: ${theme.color.surface2};
    border: 1px solid ${theme.color.border};
    color: ${theme.color.text};
    font-size: 10px;
    padding: 3px 7px;
    border-radius: 4px;
    white-space: nowrap;
    z-index: 10;
  }
`;

const BtTargetLine = styled.div<{ bottom: number }>`
  position: absolute;
  left: 0;
  right: 0;
  bottom: ${(p) => p.bottom}px;
  height: 0;
  border-top: 1px solid rgba(0, 245, 192, 0.45);
  pointer-events: none;
  z-index: 1;
  &::after {
    content: '60s target';
    position: absolute;
    right: 0;
    top: -14px;
    font-size: 9px;
    color: ${theme.color.accent};
    opacity: 0.75;
    white-space: nowrap;
  }
`;

const BtAxis = styled.div`
  display: flex;
  justify-content: space-between;
  font-size: 10px;
  color: ${theme.color.muted};
  margin-top: 4px;
`;

const ShieldStats = styled.div`
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  @media (max-width: 600px) { grid-template-columns: 1fr 1fr; }
`;

const ShieldItem = styled.div`
  text-align: center;
  padding: 14px 8px;
  background: ${theme.color.surface2};
  border-radius: 8px;
  border: 1px solid ${theme.color.borderDim};
`;

const ShieldVal = styled.div`
  font-size: 20px;
  font-weight: 700;
  color: ${theme.color.info};
`;

const ShieldLabel = styled.div`
  font-size: 10px;
  color: ${theme.color.muted};
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin-top: 4px;
`;

const BlockItem = styled.div`
  display: grid;
  grid-template-columns: 100px 1fr 80px 80px;
  gap: 12px;
  align-items: center;
  padding: 10px 0;
  border-bottom: 1px solid ${theme.color.borderDim};
  font-size: 12px;
  &:last-child { border-bottom: none; }
  @media (max-width: 600px) {
    grid-template-columns: 80px 1fr 60px;
  }
`;

const BlockHeader = styled(BlockItem)`
  color: ${theme.color.muted};
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  padding-bottom: 8px;
`;

const BlockHeight = styled.span`
  font-weight: 600;
  color: ${theme.color.accent};
  font-size: 13px;
`;

const NewBadge = styled.span`
  display: inline-block;
  background: ${theme.color.accentDim};
  color: ${theme.color.accent};
  font-size: 9px;
  padding: 1px 5px;
  border-radius: 3px;
  margin-left: 4px;
  letter-spacing: 0.05em;
`;

const BlockHash = styled.span`
  color: ${theme.color.muted};
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const BlockTxs = styled.span`
  text-align: right;
  color: ${theme.color.text};
`;

const BlockTimeCell = styled.span<{ amber?: boolean }>`
  text-align: right;
  color: ${(p) => (p.amber ? theme.color.warn : theme.color.muted)};
  font-size: 11px;
  @media (max-width: 600px) { display: none; }
`;

const LastUpdate = styled.div`
  text-align: center;
  color: ${theme.color.muted};
  font-size: 10px;
  margin-top: 32px;
  letter-spacing: 0.05em;
`;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface FetchState {
  status: StatusData | null;
  blocks: BlockData[];
  txs24h: number | null;
  loading: boolean;
  error: string | null;
  connState: 'live' | 'error' | 'idle';
  statusMsg: string;
  lastUpdated: string;
}

const initialState: FetchState = {
  status: null,
  blocks: [],
  txs24h: null,
  loading: true,
  error: null,
  connState: 'idle',
  statusMsg: 'Connecting…',
  lastUpdated: '—',
};

export const Health: React.FC = () => {
  const [apiBase, setApiBase] = useState<string>(NODE_OPTIONS[0].url);
  const [selectedOption, setSelectedOption] = useState<string>(NODE_OPTIONS[0].url);
  const [customNodeInput, setCustomNodeInput] = useState<string>('');
  const [state, setState] = useState<FetchState>(initialState);
  const lastKnownHeightRef = useRef<number>(0);
  const newHeightsRef = useRef<Set<number>>(new Set());

  const chartHostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Area'> | null>(null);

  const apiFetch = useCallback(async <T,>(base: string, path: string): Promise<T> => {
    const res = await fetch(base + path, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json() as Promise<T>;
  }, []);

  const fetchData = useCallback(async (base: string, isRefresh: boolean) => {
    try {
      setState((s) => ({ ...s, statusMsg: isRefresh ? 'Refreshing…' : 'Connecting…', connState: 'idle' }));
      const status = await apiFetch<StatusData>(base, '/status');
      const heights = Array.from({ length: UNIQUE_BLOCKS_NEEDED }, (_, i) => status.height - i);
      const [blocksRaw, hdrs] = await Promise.all([
        Promise.all(heights.map((h) => apiFetch<BlockData>(base, `/block?height=${h}`).catch(() => null))),
        apiFetch<HdrsResponse>(base, `/hdrs?hMax=${status.height}&nMax=2&dh=1440&cols=K`).catch(() => null),
      ]);
      const blocks = (blocksRaw.filter((b): b is BlockData => !!b && b.found !== false))
        .sort((a, b) => getHeight(b) - getHeight(a));

      // Track new heights for badge
      const topH = blocks[0] ? getHeight(blocks[0]) : 0;
      const newSet = new Set<number>();
      if (isRefresh && topH > lastKnownHeightRef.current) {
        for (const b of blocks) {
          const bh = getHeight(b);
          if (bh > lastKnownHeightRef.current) newSet.add(bh);
          else break;
        }
      }
      newHeightsRef.current = newSet;
      if (topH) lastKnownHeightRef.current = topH;

      setState({
        status,
        blocks,
        txs24h: parseTxs24hFromHdrs(hdrs),
        loading: false,
        error: null,
        connState: 'live',
        statusMsg: 'Live · mainnet',
        lastUpdated: new Date().toLocaleTimeString(),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      setState((s) => ({
        ...s,
        loading: false,
        error: `Could not reach node: ${msg}. Try a different node or enter a custom URL.`,
        connState: 'error',
        statusMsg: `Error — ${msg}`,
      }));
    }
  }, [apiFetch]);

  useEffect(() => {
    lastKnownHeightRef.current = 0;
    void fetchData(apiBase, false);
    const id = window.setInterval(() => { void fetchData(apiBase, true); }, REFRESH_INTERVAL_MS);
    return () => { window.clearInterval(id); };
  }, [apiBase, fetchData]);

  // Compute derived metrics
  const blocks = state.blocks;
  const latest = blocks[0];

  const blockTimes: number[] = [];
  for (let i = 0; i < blocks.length - 1; i += 1) {
    const dt = blocks[i].timestamp - blocks[i + 1].timestamp;
    if (dt > 0 && dt < 1800) blockTimes.push(dt);
  }
  const avgBlockTime = blockTimes.length > 0
    ? blockTimes.reduce((a, b) => a + b, 0) / blockTimes.length
    : 0;

  const latestDiff = latest?.difficulty ?? 0;
  const solPerSec = avgBlockTime > 0 ? diffToHashrate(latestDiff, avgBlockTime) : 0;
  const hashrate = fmtBeamSolutionsPerSec(solPerSec);

  const txs24hDisplay: { val: string; sub: string } = (() => {
    if (state.txs24h != null) {
      return {
        val: state.txs24h.toLocaleString(),
        sub: 'Δ T.Txs · 1440 blocks (~24h)',
      };
    }
    if (blocks.length > 0) {
      const kernelsIn60 = blocks.reduce((acc, b) => acc + (b.kernels ?? []).filter((k) => (k.fee ?? 0) > 0).length, 0);
      const txs24h = Math.round(kernelsIn60 * 24);
      return { val: txs24h.toLocaleString(), sub: 'estimated · last 60 blocks × 24' };
    }
    return { val: '···', sub: 'kernels processed' };
  })();

  // Build hashrate series (oldest first for left-to-right)
  const hashrateSeriesData: LineData[] = (() => {
    if (!blocks || blocks.length < 2 || avgBlockTime <= 0) return [];
    const sortedAsc = [...blocks].reverse(); // oldest first
    return sortedAsc.map((b, idx) => {
      const next = sortedAsc[idx + 1];
      const bt = next ? (next.timestamp - b.timestamp) : avgBlockTime;
      const safeBt = (bt > 0 && bt < 1800) ? bt : avgBlockTime;
      return {
        time: b.timestamp as UTCTimestamp,
        value: diffToHashrate(b.difficulty ?? latestDiff, safeBt) / 1000, // KS/s
      };
    });
  })();

  // Init/update chart
  useEffect(() => {
    const host = chartHostRef.current;
    if (!host) return;
    if (!chartRef.current) {
      const chart = createChart(host, {
        autoSize: true,
        layout: {
          background: { type: ColorType.Solid, color: theme.color.surface },
          textColor: theme.color.muted,
          fontSize: 10,
        },
        grid: {
          vertLines: { color: 'rgba(0, 245, 192, 0.04)' },
          horzLines: { color: 'rgba(0, 245, 192, 0.06)' },
        },
        rightPriceScale: { borderColor: theme.color.borderDim },
        timeScale: {
          borderColor: theme.color.borderDim,
          timeVisible: true,
          secondsVisible: false,
        },
        crosshair: { vertLine: { style: LineStyle.Dotted }, horzLine: { style: LineStyle.Dotted } },
      });
      const series = chart.addAreaSeries({
        lineColor: theme.color.accent,
        topColor: 'rgba(0, 245, 192, 0.25)',
        bottomColor: 'rgba(0, 245, 192, 0.0)',
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      chartRef.current = chart;
      seriesRef.current = series;
    }
    if (seriesRef.current && hashrateSeriesData.length > 0) {
      seriesRef.current.setData(hashrateSeriesData);
      chartRef.current?.timeScale().fitContent();
    }
  }, [hashrateSeriesData]);

  useEffect(() => () => {
    if (chartRef.current) {
      chartRef.current.remove();
      chartRef.current = null;
      seriesRef.current = null;
    }
  }, []);

  // Block time bars
  const btMaxT = Math.max(...blockTimes, 120);
  const btHeight = 100;
  const btTargetBottom = (60 / btMaxT) * btHeight;
  const btTimesForDisplay = [...blockTimes].reverse(); // oldest first → display left-to-right? original uses reversed list

  // Shielded
  const shieldedTotal = state.status?.shielded_outputs_total ?? 0;
  const shielded24h = state.status?.shielded_outputs_per_24h ?? 0;
  const readyHoursRaw = state.status?.shielded_possible_ready_in_hours;
  const readyHours = typeof readyHoursRaw === 'string' ? parseFloat(readyHoursRaw) : (readyHoursRaw ?? 0);
  let readyDisplay = '—';
  if (readyHours > 8760) readyDisplay = '> 1 year';
  else if (readyHours > 24) readyDisplay = `${Math.round(readyHours / 24)} days`;
  else if (readyHours > 0) readyDisplay = `${Math.round(readyHours)}h`;

  // Price
  const priceUsd = latest?.rate_usd && parseFloat(String(latest.rate_usd)) > 0
    ? `$${parseFloat(String(latest.rate_usd)).toFixed(4)}` : '—';
  const priceBtc = latest?.rate_btc && parseFloat(String(latest.rate_btc)) > 0
    ? `₿ ${parseFloat(String(latest.rate_btc)).toFixed(8)}` : '—';

  // Block feed (top 20)
  const feedBlocks = blocks.slice(0, 20);

  // Block time KPI
  const blockTimeKpi = avgBlockTime > 0 ? `${avgBlockTime.toFixed(1)}s` : '···';
  const blockTimeAmber = avgBlockTime > 0 && (avgBlockTime < 45 || avgBlockTime > 90);

  const onNodeChange = (val: string): void => {
    setSelectedOption(val);
    if (val !== 'custom') {
      setApiBase(val);
    }
  };

  const applyCustomNode = (): void => {
    const v = customNodeInput.trim().replace(/\/$/, '');
    if (!v) return;
    setApiBase(v);
    setSelectedOption('custom');
  };

  const dotKind: 'live' | 'error' | 'idle' = state.connState;

  return (
    <Page>
      <ExplorerHeader>
        <TitleBlock>
          <H1>BEAM Network</H1>
          <Subtitle>Health Dashboard</Subtitle>
        </TitleBlock>
        <HeaderRight>
          <StatusRow>
            <Dot data-kind={dotKind} />
            <span>{state.statusMsg}</span>
          </StatusRow>
          <NodeSelector
            options={NODE_SELECT_OPTIONS}
            value={selectedOption}
            onChange={onNodeChange}
            label="Node:"
          />
          {selectedOption === 'custom' && (
            <CustomNodeRow>
              <Input
                placeholder="http://localhost:8888"
                value={customNodeInput}
                onChange={(e) => setCustomNodeInput(e.target.value)}
              />
              <Btn type="button" onClick={applyCustomNode}>Connect</Btn>
            </CustomNodeRow>
          )}
        </HeaderRight>
      </ExplorerHeader>

      {state.error && <ErrorBox>{state.error}</ErrorBox>}

      <PriceBar>
        <PriceLabel>BEAM</PriceLabel>
        <PriceUsd>{priceUsd}</PriceUsd>
        <PriceBtc>{priceBtc}</PriceBtc>
        <PriceSep>|</PriceSep>
        <PriceLabel>Network:</PriceLabel>
        <NetworkName>
          Mainnet
          {state.status?.peers_count !== undefined ? ` · ${state.status.peers_count} peers` : ''}
        </NetworkName>
      </PriceBar>

      <StatGrid>
        <StatCard>
          <StatCardAccentBar />
          <Label>Block height</Label>
          <StatValue tone={state.status ? 'accent' : 'loading'}>
            {state.status ? Number(state.status.height).toLocaleString() : '···'}
          </StatValue>
          <StatSub>{latest?.hash ? `${latest.hash.slice(0, 20)}…` : '—'}</StatSub>
        </StatCard>
        <StatCard>
          <Label>Hashrate</Label>
          <StatValue tone={solPerSec > 0 ? 'accent' : 'loading'}>
            {solPerSec > 0 ? `${hashrate.val} ${hashrate.unit}` : '···'}
          </StatValue>
          <StatSub>
            {solPerSec > 0
              ? `BeamHash III · difficulty ÷ avg block time (${blockTimes.length} intervals)`
              : 'estimated from difficulty'}
          </StatSub>
        </StatCard>
        <StatCard>
          <Label>Difficulty</Label>
          <StatValue tone={latestDiff > 0 ? 'normal' : 'loading'}>
            {latestDiff > 0 ? fmtDifficulty(latestDiff) : '···'}
          </StatValue>
          <StatSub>BeamHash III</StatSub>
        </StatCard>
        <StatCard>
          <Label>Avg block time</Label>
          <StatValue tone={avgBlockTime > 0 ? (blockTimeAmber ? 'amber' : 'accent') : 'loading'}>
            {blockTimeKpi}
          </StatValue>
          <StatSub>target: 60s</StatSub>
        </StatCard>
        <StatCard>
          <Label>Transactions (24h)</Label>
          <StatValue tone={txs24hDisplay.val !== '···' ? 'normal' : 'loading'}>
            {txs24hDisplay.val}
          </StatValue>
          <StatSub>{txs24hDisplay.sub}</StatSub>
        </StatCard>
        <StatCard>
          <Label>Shielded outputs</Label>
          <StatValue tone={state.status ? 'amber' : 'loading'}>
            {state.status ? fmt(shieldedTotal) : '···'}
          </StatValue>
          <StatSub>{`${shielded24h.toLocaleString()} in last 24h`}</StatSub>
        </StatCard>
      </StatGrid>

      <SectionLabel>Hashrate &amp; block timing</SectionLabel>

      <Grid2>
        <Panel>
          <PanelHeader>
            <PanelTitle>Hashrate trend (last 60 blocks)</PanelTitle>
            <PanelAside>{hashrate.unit}</PanelAside>
          </PanelHeader>
          <PanelBody>
            <ChartHost ref={chartHostRef} />
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHeader>
            <PanelTitle>Block times (last 60 blocks)</PanelTitle>
            <PanelAside>{avgBlockTime > 0 ? `avg ${avgBlockTime.toFixed(1)}s` : 'avg —s'}</PanelAside>
          </PanelHeader>
          <PanelBody>
            <BlockTimeWrap>
              <BlockTimeBars>
                {btTimesForDisplay.map((t, i) => {
                  const pct = Math.min(t / btMaxT, 1);
                  const barH = Math.max(2, Math.round(pct * btHeight));
                  let color: string = theme.color.accent;
                  if (t < 30) color = theme.color.danger;
                  else if (t < 45) color = theme.color.warn;
                  else if (t <= 90) color = theme.color.accent;
                  else if (t <= 120) color = theme.color.warn;
                  else color = theme.color.danger;
                  return (
                    <BtBar
                      // eslint-disable-next-line react/no-array-index-key
                      key={i}
                      color={color}
                      barHeight={barH}
                      data-tip={`${t}s`}
                    />
                  );
                })}
              </BlockTimeBars>
              {btTimesForDisplay.length > 0 && <BtTargetLine bottom={btTargetBottom} />}
            </BlockTimeWrap>
            <BtAxis>
              <span>60 blocks ago</span>
              <span>now</span>
            </BtAxis>
          </PanelBody>
        </Panel>
      </Grid2>

      <SectionLabel>Privacy layer</SectionLabel>

      <Panel style={{ marginBottom: 16 }}>
        <PanelHeader>
          <PanelTitle>LelantusMW shielded pool</PanelTitle>
        </PanelHeader>
        <PanelBody>
          <ShieldStats>
            <ShieldItem>
              <ShieldVal>{shieldedTotal ? shieldedTotal.toLocaleString() : '—'}</ShieldVal>
              <ShieldLabel>Total shielded outputs</ShieldLabel>
            </ShieldItem>
            <ShieldItem>
              <ShieldVal>{shielded24h ? shielded24h.toLocaleString() : '—'}</ShieldVal>
              <ShieldLabel>Shielded in 24h</ShieldLabel>
            </ShieldItem>
            <ShieldItem>
              <ShieldVal>{readyDisplay}</ShieldVal>
              <ShieldLabel>Hours until max anon set</ShieldLabel>
            </ShieldItem>
          </ShieldStats>
        </PanelBody>
      </Panel>

      <SectionLabel>Recent blocks</SectionLabel>

      <Panel>
        <PanelHeader>
          <PanelTitle>Live block feed</PanelTitle>
          <PanelAside>auto-refreshes every 30s</PanelAside>
        </PanelHeader>
        <PanelBody style={{ padding: '8px 18px' }}>
          <BlockHeader>
            <span>Height</span>
            <span>Hash</span>
            <span style={{ textAlign: 'right' }}>Kernels</span>
            <span style={{ textAlign: 'right' }}>Time delta</span>
          </BlockHeader>
          {feedBlocks.map((b, i) => {
            const bh = getHeight(b);
            const next = feedBlocks[i + 1];
            const dt = next ? (b.timestamp - next.timestamp) : null;
            const dtStr = dt !== null && dt > 0 ? `${dt}s` : '—';
            const dtAmber = dt !== null && (dt < 30 || dt > 120);
            const payingKernels = (b.kernels ?? []).filter((k) => (k.fee ?? 0) > 0).length;
            const isNew = newHeightsRef.current.has(bh);
            return (
              <BlockItem key={`${bh}-${b.hash ?? i}`}>
                <BlockHeight>
                  {Number(bh).toLocaleString()}
                  {isNew && <NewBadge>NEW</NewBadge>}
                </BlockHeight>
                <BlockHash>{b.hash ?? '—'}</BlockHash>
                <BlockTxs>{payingKernels > 0 ? `${payingKernels} tx` : '—'}</BlockTxs>
                <BlockTimeCell amber={dtAmber}>{dtStr}</BlockTimeCell>
              </BlockItem>
            );
          })}
        </PanelBody>
      </Panel>

      <LastUpdate>
        {`Last updated: ${state.lastUpdated} · Auto-refresh every 30s · `}
        <a
          href="https://beam.mw"
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: theme.color.muted, textDecoration: 'none' }}
        >
          beam.mw
        </a>
      </LastUpdate>
    </Page>
  );
};

export default Health;
