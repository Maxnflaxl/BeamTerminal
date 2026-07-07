import React, { useEffect, useRef, useState, useCallback } from 'react';
import { styled } from '@linaria/react';
import {
  createChart, ColorType, LineStyle,
} from 'lightweight-charts';
import type {
  IChartApi, ISeriesApi, LineData, UTCTimestamp,
} from 'lightweight-charts';
import {
  Page, ExplorerHeader, H1, Subtitle, Label,
  StatGrid, StatCard, ErrorBox, theme,
  fmtHashrateParts,
} from './shared';
import { api } from '../../api/client';
import type { ApiNetwork } from '../../api/types';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const REFRESH_INTERVAL_MS = 30_000;
// The node is now only used for the live block feed (per-block hashes, which we
// don't store) + shielded-pool/peer stats. All numeric tiles and the hashrate/
// block-time/kernels charts come from our backend (/api/network), so we fetch
// just enough blocks to fill the feed instead of the old 60-block window.
const FEED_BLOCKS = 20;

// Fixed explorer node — the node selector was removed; the live block feed and
// shielded/peer stats always read from our own explorer.
const EXPLORER_API_BASE = 'https://explorer.0xmx.net/api';

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

function getHeight(b: BlockData): number {
  return (b.height ?? b.h ?? 0);
}

// ---------------------------------------------------------------------------
// Page-specific styled (unique presentation only — colors via theme.color.*)
// ---------------------------------------------------------------------------

const TitleBlock = styled.div`
  display: flex;
  flex-direction: column;
`;

const PriceBar = styled.div`
  display: flex;
  align-items: center;
  & > * + * { margin-left: 16px; }
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
  & > * + * { margin-left: 12px; }
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
  & > * + * { margin-left: 8px; }
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
  & > * + * { margin-left: 3px; }
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
  loading: boolean;
  error: string | null;
  connState: 'live' | 'error' | 'idle';
  statusMsg: string;
  lastUpdated: string;
}

const initialState: FetchState = {
  status: null,
  blocks: [],
  loading: true,
  error: null,
  connState: 'idle',
  statusMsg: 'Connecting…',
  lastUpdated: '—',
};

// Backend-sourced network data (canonical hashrate/difficulty/block-time/tip
// and oracle price). Independent of the node feed so a node outage never
// blanks these, and vice-versa.
interface NetworkState {
  net: ApiNetwork | null;
  beamUsd: number | null;
}

const initialNetworkState: NetworkState = { net: null, beamUsd: null };

export const Health: React.FC = () => {
  const apiBase = EXPLORER_API_BASE;
  const [state, setState] = useState<FetchState>(initialState);
  const [netState, setNetState] = useState<NetworkState>(initialNetworkState);
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

  // Node fetch — the live block feed (per-block hashes) + shielded/peer stats
  // from /status only. Numeric tiles and charts come from the backend below.
  const fetchData = useCallback(async (base: string, isRefresh: boolean) => {
    try {
      setState((s) => ({ ...s, statusMsg: isRefresh ? 'Refreshing…' : 'Connecting…', connState: 'idle' }));
      const status = await apiFetch<StatusData>(base, '/status');
      const heights = Array.from({ length: FEED_BLOCKS }, (_, i) => status.height - i);
      const blocksRaw = await Promise.all(
        heights.map((h) => apiFetch<BlockData>(base, `/block?height=${h}`).catch(() => null)),
      );
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

  // Backend fetch — canonical network snapshot, oracle price, tx throughput.
  // Runs on the same cadence but is independent of the selected node.
  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      const [net, stats] = await Promise.all([
        api.network().catch(() => null),
        api.stats().catch(() => null),
      ]);
      if (cancelled) return;
      setNetState((prev) => ({
        net: net ?? prev.net,
        beamUsd: stats?.beam_usd ?? prev.beamUsd,
      }));
    };
    void load();
    const id = window.setInterval(() => { void load(); }, REFRESH_INTERVAL_MS);
    return () => { cancelled = true; window.clearInterval(id); };
  }, []);

  // Compute derived metrics
  const blocks = state.blocks;   // node blocks — used for the live feed only
  const latest = blocks[0];      // newest node block (hash + BTC price)
  const net = netState.net;

  // Recent blocks from the backend (oldest→newest) power the numeric tiles and
  // the hashrate/block-time/kernels charts — the canonical, node-independent
  // source that matches the Mining page and /api/network.
  const recent = net?.recent ?? [];

  // Per-interval block times (seconds), oldest→newest, for the bars.
  const blockTimes: number[] = [];
  for (let i = 0; i < recent.length - 1; i += 1) {
    const dt = recent[i + 1].ts - recent[i].ts;
    if (dt > 0 && dt < 1800) blockTimes.push(dt);
  }

  const avgBlockTime = net?.avg_block_time ?? 0;
  const latestDiff = net?.difficulty ?? 0;
  const solPerSec = net?.hashrate ?? 0;
  const hashrate = fmtHashrateParts(net?.hashrate ?? null);

  const txs24hDisplay: { val: string; sub: string } = (() => {
    if (recent.length > 0) {
      const kernelsInWindow = recent.reduce((acc, b) => acc + (b.kernels ?? 0), 0);
      const perBlock = kernelsInWindow / recent.length;
      const txs24h = Math.round(perBlock * 1440); // kernels/block × blocks/day
      return { val: txs24h.toLocaleString(), sub: `estimated · kernels/block × 1440 (${recent.length} blocks)` };
    }
    return { val: '···', sub: 'kernels processed' };
  })();

  // Build hashrate series (oldest→newest for left-to-right) from backend blocks.
  const hashrateSeriesData: LineData[] = (() => {
    if (recent.length < 2) return [];
    const points = recent.map((b, idx) => {
      const next = recent[idx + 1];
      const bt = next ? (next.ts - b.ts) : avgBlockTime;
      const safeBt = (bt > 0 && bt < 1800) ? bt : (avgBlockTime || 60);
      return {
        time: b.ts as UTCTimestamp,
        value: diffToHashrate(b.difficulty, safeBt) / 1000, // KSol/s
      };
    });
    // lightweight-charts requires strictly-ascending, unique timestamps. Block
    // timestamps aren't monotonic with height (two blocks can share a second,
    // or drift backwards), so sort by time and collapse equal-timestamp points
    // (last value wins) before setData — which would otherwise assert and take
    // the whole page down via the error boundary.
    points.sort((a, b) => (a.time as number) - (b.time as number));
    const deduped: LineData[] = [];
    for (const p of points) {
      const last = deduped[deduped.length - 1];
      if (last && last.time === p.time) deduped[deduped.length - 1] = p;
      else deduped.push(p);
    }
    return deduped;
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
  const btTimesForDisplay = blockTimes; // already oldest→newest (left→right)

  // Shielded
  const shieldedTotal = state.status?.shielded_outputs_total ?? 0;
  const shielded24h = state.status?.shielded_outputs_per_24h ?? 0;
  const readyHoursRaw = state.status?.shielded_possible_ready_in_hours;
  const readyHours = typeof readyHoursRaw === 'string' ? parseFloat(readyHoursRaw) : (readyHoursRaw ?? 0);
  let readyDisplay = '—';
  if (readyHours > 8760) readyDisplay = '> 1 year';
  else if (readyHours > 24) readyDisplay = `${Math.round(readyHours / 24)} days`;
  else if (readyHours > 0) readyDisplay = `${Math.round(readyHours)}h`;

  // Price — USD from the oracle (same source as the rest of the app); BTC from
  // the node's latest block (the oracle only publishes BEAM/USD).
  const priceUsd = netState.beamUsd != null && netState.beamUsd > 0
    ? `$${netState.beamUsd.toFixed(4)}` : '—';
  const priceBtc = latest?.rate_btc && parseFloat(String(latest.rate_btc)) > 0
    ? `₿ ${parseFloat(String(latest.rate_btc)).toFixed(8)}` : '—';

  // Block feed (top 20)
  const feedBlocks = blocks.slice(0, 20);

  // Block time KPI
  const blockTimeKpi = avgBlockTime > 0 ? `${avgBlockTime.toFixed(1)}s` : '···';
  const blockTimeAmber = avgBlockTime > 0 && (avgBlockTime < 45 || avgBlockTime > 90);

  return (
    <Page>
      <ExplorerHeader>
        <TitleBlock>
          <H1>BEAM Network</H1>
          <Subtitle>Health Dashboard</Subtitle>
        </TitleBlock>
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
          <StatValue tone={net?.tip_height != null || state.status ? 'accent' : 'loading'}>
            {net?.tip_height != null
              ? net.tip_height.toLocaleString()
              : (state.status ? Number(state.status.height).toLocaleString() : '···')}
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
              ? `BeamHash III · Σ difficulty ÷ Δt (${recent.length} blocks)`
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
