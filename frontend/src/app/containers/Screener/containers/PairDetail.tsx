import React, {
  useCallback, useEffect, useMemo, useState,
} from 'react';
import { styled } from '@linaria/react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  usePair, useOhlcv, usePagedTrades, useAssetHistory,
} from '../hooks';
import type {
  ApiCandle, ApiPair, Interval, Denom,
} from '../api/types';
import AssetIcon from '@app/shared/components/AssetsIcon';
import { ROUTES } from '@app/shared/constants';
import { Chart } from '../components/Chart';
import { IconsPair } from '../components/IconsPair';
import { KindBadge, TiersBadge } from '../components/KindBadge';
import { SwapPanel, type TradePreview } from '../components/SwapPanel';
import { useAssetColor } from '../assetColors';
import { AssetMetaBanner } from '../components/AssetMetaBanner';
import { LiquidityBanner } from '../components/LiquidityBanner';
import { Pager } from '../components/Pager';
import { tierFeePct } from '../components/modalChrome';
import {
  fmt$, fmtPct, fmtPrice, fmtDate, fmtDateFull, fmtNum, fmtPriceImpact, pairUrlId,
} from '../components/format';

const TRADES_PAGE_SIZE = 50;

const INTERVALS: Interval[] = ['1m', '5m', '15m', '1h', '4h', '1d'];

const INTERVAL_SECONDS: Record<Interval, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '4h': 14_400,
  '1d': 86_400,
};

// Above this many points we leave the series sparse rather than synthesize a
// huge run of flat bars — guards illiquid pairs whose loaded candles span a
// big window on a fine timeframe (e.g. weekly trades viewed on 1m).
const MAX_DENSE_CANDLES = 5000;

/**
 * Forward-fill no-trade buckets so they keep their slot on the time axis.
 *
 * Continuous-aggregate candles only exist for buckets that had trades, and
 * lightweight-charts spaces data points *ordinally* (not by real time) — so a
 * sparse series renders no-trade days adjacent and their dates vanish from the
 * axis. Insert a flat doji (open=high=low=close=prev close, zero volume) for
 * each missing bucket between the first and last loaded candle. `rawCandles`
 * is strictly ascending; the loop never drops a real candle, so a misaligned
 * bucket only mis-sizes a gap rather than corrupting the series.
 */
function densifyCandles(candles: ApiCandle[], bucketSeconds: number): ApiCandle[] {
  if (candles.length < 2) return candles;
  const first = candles[0]!.time;
  const last = candles[candles.length - 1]!.time;
  const span = Math.floor((last - first) / bucketSeconds) + 1;
  // Already gapless, or too sparse to fill without exploding the array.
  if (span <= candles.length || span > MAX_DENSE_CANDLES) return candles;

  const out: ApiCandle[] = [candles[0]!];
  for (let i = 1; i < candles.length; i += 1) {
    const prev = candles[i - 1]!;
    const cur = candles[i]!;
    const missing = Math.round((cur.time - prev.time) / bucketSeconds) - 1;
    for (let g = 1; g <= missing; g += 1) {
      out.push({
        time: prev.time + g * bucketSeconds,
        open: prev.close,
        high: prev.close,
        low: prev.close,
        close: prev.close,
        volume: '0',
        trade_count: 0,
      });
    }
    out.push(cur);
  }
  return out;
}

const Page = styled.div`
  width: 100%;
  max-width: 100%;
  padding: 12px 12px 0;
  box-sizing: border-box;
`;

const Layout = styled.div`
  display: grid;
  grid-template-columns: 1fr 320px;
  gap: 0;
  min-height: calc(100vh - 130px);
  width: 100%;
  max-width: 100%;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;

  @media (max-width: 960px) {
    grid-template-columns: 1fr;
  }
`;

const Left = styled.div`
  display: flex;
  flex-direction: column;
  border-right: 1px solid rgba(255, 255, 255, 0.08);
  min-width: 0;

  @media (max-width: 960px) {
    border-right: none;
  }
`;

const TopBar = styled.div`
  display: flex;
  align-items: center;
  & > * + * { margin-left: 12px; }
  padding: 12px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
`;

const BackBtn = styled.button`
  background: none;
  border: none;
  color: rgba(255, 255, 255, 0.6);
  font-size: 18px;
  padding: 4px 8px;
  border-radius: 4px;
  cursor: pointer;
  &:hover {
    background: rgba(255, 255, 255, 0.06);
    color: white;
  }
`;

const TopTitle = styled.div`
  font-size: 18px;
  font-weight: 700;
`;

const TopSubtitle = styled.div`
  font-size: 11px;
  color: rgba(255, 255, 255, 0.4);
`;

const ChartArea = styled.div`
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
`;

const Toolbar = styled.div`
  display: flex;
  align-items: center;
  & > * + * { margin-left: 4px; }
  padding: 8px 14px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  flex-wrap: wrap;
  button {
    padding: 4px 10px;
    font-size: 12px;
    background: transparent;
    color: rgba(255, 255, 255, 0.5);
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-family: inherit;
    &:hover {
      background: rgba(255, 255, 255, 0.06);
      color: rgba(255, 255, 255, 0.8);
    }
    &.active {
      background: var(--color-green);
      color: var(--color-dark-blue);
      font-weight: 600;
    }
  }
  .sep {
    width: 1px;
    height: 18px;
    background: rgba(255, 255, 255, 0.1);
    margin: 0 6px;
  }
`;

// Custom-styled date selector: a real text input on the left (placeholder
// "CENTER ON YYYY-MM-DD") that the user types into, plus a calendar-icon
// button on the right that opens the native picker as an alternative. The
// picker button hosts a transparent <input type="date"> overlay sized to the
// icon's hit area, so clicking the icon — and only the icon — opens the
// browser's date picker. That keeps the body of the control typeable while
// still giving us a one-click picker affordance on Chrome 83, where
// input.showPicker() doesn't exist yet.
const CenterOnDate = styled.div`
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  padding: 3px 3px 3px 10px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 4px;
  font-size: 12px;
  font-family: inherit;
  color-scheme: dark;
  transition: background 120ms, border-color 120ms;
  &:focus-within {
    background: rgba(255, 255, 255, 0.08);
    border-color: var(--color-green);
  }
  input[type='text'] {
    background: transparent;
    border: none;
    color: var(--color-green);
    font: inherit;
    font-weight: 600;
    letter-spacing: 0.4px;
    outline: none;
    padding: 1px 0;
    width: 160px;
    text-transform: uppercase;
    &::placeholder {
      color: rgba(255, 255, 255, 0.4);
      font-weight: 400;
      letter-spacing: 0.4px;
    }
  }
  .pickerBtn {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    margin-left: 4px;
    border-radius: 3px;
    color: rgba(255, 255, 255, 0.5);
    cursor: pointer;
    transition: background 120ms, color 120ms;
    &:hover {
      background: rgba(255, 255, 255, 0.08);
      color: var(--color-green);
    }
    svg {
      width: 13px;
      height: 13px;
      pointer-events: none;
    }
    input[type='date'] {
      position: absolute;
      top: 0;
      right: 0;
      bottom: 0;
      left: 0;
      width: 100%;
      height: 100%;
      opacity: 0;
      border: none;
      padding: 0;
      margin: 0;
      background: transparent;
      color: transparent;
      font: inherit;
      cursor: pointer;
      color-scheme: dark;
      &::-webkit-calendar-picker-indicator {
        position: absolute;
        top: 0;
        right: 0;
        bottom: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: transparent;
        cursor: pointer;
      }
      &::-webkit-datetime-edit,
      &::-webkit-inner-spin-button,
      &::-webkit-clear-button { display: none; }
    }
  }
`;

const ChartContainer = styled.div`
  flex: 1;
  /* This floor is what actually sizes the chart on normal viewports: the
     Left column's content is taller than calc(100vh - 130px), so flex:1 has
     no spare room to grow the chart and it sits at this min. Keep it tall. */
  min-height: 520px;
  position: relative;
`;

const TradesPanel = styled.div`
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  min-width: 0;
`;

const FeedHeader = styled.div`
  padding: 10px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  font-size: 13px;
  font-weight: 600;
  color: white;
`;

const TradesWrap = styled.div`
  max-height: 320px;
  overflow-y: auto;
  overflow-x: auto;
  table {
    width: 100%;
    border-collapse: collapse;
    th {
      text-align: left;
      padding: 8px 10px;
      font-size: 11px;
      color: rgba(255, 255, 255, 0.4);
      text-transform: uppercase;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      position: sticky;
      top: 0;
      background: var(--color-dark-blue);
      z-index: 1;
      white-space: nowrap;
    }
    td {
      padding: 6px 10px;
      font-size: 12px;
      font-family: 'SFProDisplay', monospace;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      white-space: nowrap;
    }
  }
  .buy { color: #00f6d2; font-weight: 600; }
  .sell { color: #f25f5b; font-weight: 600; }
`;

const Sidebar = styled.div`
  display: flex;
  flex-direction: column;
  background: rgba(255, 255, 255, 0.02);
  overflow-y: auto;
  min-width: 0;
`;

const SidebarSection = styled.div`
  padding: 14px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  h4 {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.4);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin: 0 0 8px;
  }
`;

const PriceRow = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  & > * + * { margin-left: 8px; }
  .lbl { font-size: 11px; color: rgba(255, 255, 255, 0.4); text-transform: uppercase; }
  .val { font-family: 'SFProDisplay', monospace; font-size: 18px; font-weight: 700; color: white; }
  .native { font-family: 'SFProDisplay', monospace; font-size: 13px; color: rgba(255, 255, 255, 0.6); }
`;

const ChangeGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  .cell {
    text-align: center;
    padding: 10px 4px;
    border-right: 1px solid rgba(255, 255, 255, 0.06);
    &:last-child { border-right: none; }
    .lbl { font-size: 10px; color: rgba(255, 255, 255, 0.4); text-transform: uppercase; }
    .val { font-family: 'SFProDisplay', monospace; font-size: 13px; font-weight: 600; }
  }
`;

const StatRow = styled.div`
  display: flex;
  justify-content: space-between;
  padding: 5px 0;
  font-size: 13px;
  .lbl { color: rgba(255, 255, 255, 0.5); }
  .val { font-family: 'SFProDisplay', monospace; color: white; }
`;

const PoolRow = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 5px 0;
  font-size: 13px;
  & > * + * { margin-left: 8px; }
  .name { display: flex; align-items: center; min-width: 0; }
  .lbl {
    color: rgba(255, 255, 255, 0.85);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .lbl small { color: rgba(255, 255, 255, 0.4); margin-left: 4px; }
  .val { font-family: 'SFProDisplay', monospace; text-align: right; white-space: nowrap; }
  .usd { color: rgba(255, 255, 255, 0.4); font-size: 11px; margin-left: 6px; }
`;

// Same icon the trade panel / lists render; trimmed to a tight 20px slot with
// a small right gap to the symbol label.
const PoolAssetIcon = styled(AssetIcon)`
  && { margin-right: 8px; }
  flex-shrink: 0;
`;

const RateLine = styled.div`
  display: flex;
  align-items: center;
  & > * + * { margin-left: 6px; }
  font-size: 13px;
  font-family: 'SFProDisplay', monospace;
  .lbl { color: rgba(255, 255, 255, 0.5); font-family: 'ProximaNova', sans-serif; font-size: 13px; }
`;

const FlipRateBtn = styled.button`
  background: rgba(255, 255, 255, 0.06);
  border: none;
  color: rgba(255, 255, 255, 0.6);
  width: 22px;
  height: 22px;
  border-radius: 50%;
  font-size: 12px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  &:hover { background: rgba(255, 255, 255, 0.12); color: white; }
`;

const TxnsBar = styled.div`
  display: flex;
  height: 6px;
  border-radius: 3px;
  overflow: hidden;
  margin-bottom: 4px;
  .buy-fill { background: #00f6d2; }
  .sell-fill { background: #f25f5b; }
`;

const Loading = styled.div`
  text-align: center;
  padding: 60px 20px;
  color: rgba(255, 255, 255, 0.5);
`;

const TierBar = styled.div`
  display: flex;
  align-items: center;
  & > * + * { margin-left: 6px; }
  padding: 8px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  flex-wrap: wrap;
  .lbl {
    color: rgba(255, 255, 255, 0.4);
    margin-right: 2px;
    text-transform: uppercase;
    font-size: 10px;
    letter-spacing: 0.5px;
  }
`;

const TierPill = styled.button<{ active?: boolean }>`
  padding: 4px 10px;
  border-radius: 14px;
  border: 1px solid ${(p) => (p.active ? 'var(--color-green)' : 'rgba(255, 255, 255, 0.15)')};
  background: ${(p) => (p.active ? 'rgba(0, 246, 210, 0.15)' : 'transparent')};
  color: ${(p) => (p.active ? '#00f6d2' : 'rgba(255, 255, 255, 0.6)')};
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  &:hover { border-color: rgba(0, 246, 210, 0.5); }
`;

export const PairDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [interval, setInterval_] = useState<Interval>('1h');
  const [chartStyle, setChartStyle] = useState<'candle' | 'area'>('area');
  const [metric, setMetric] = useState<'price' | 'mc'>('price');
  const [denom, setDenom_] = useState<Denom>('native');
  // Default to inverted (aid1-per-aid2): the rest of the UI — pair title
  // "sym1/sym2", PRICE column, MC — all describe aid2 (the non-BEAM side).
  // Charting native (aid2-per-aid1) by default trends in the opposite
  // direction from what the title implies. Keep the toggle for users who
  // want the raw native quote.
  const [flipChart, setFlipChart] = useState(true);
  const [tradesPage, setTradesPage] = useState(0);
  // null = Auto (combined across tiers); otherwise a specific fee tier's kind.
  const [selectedKind, setSelectedKind] = useState<number | null>(null);
  // Unix-seconds date to center the price chart on (from the toolbar date input).
  const [chartCenterOn, setChartCenterOn] = useState<number | null>(null);
  // YYYY-MM-DD string mirroring the same selection — drives the placeholder
  // overlay on the styled date control and lets us render a clear (×) button.
  const [centerOnDate, setCenterOnDate] = useState<string>('');
  // Bumped when the user clears the date input and presses Enter — tells the
  // chart to fitContent() again so the view returns to the default zoom.
  const [chartFitNonce, setChartFitNonce] = useState(0);
  // The chart defaults to flipped (showing aid1-per-aid2 — i.e., BEAM per
  // BeamX on a BEAM-quoted pair). Match the rate-switcher default so the
  // sidebar reads in the same orientation as the chart and the user doesn't
  // see two opposite numbers for the same pool.
  const [flipRate, setFlipRate] = useState(true);
  const [tradePreview, setTradePreview] = useState<TradePreview | null>(null);
  // Stable identity so the SwapPanel doesn't re-fire its preview-emit effect
  // every render of PairDetail.
  const onPreviewChange = useCallback((p: TradePreview | null) => setTradePreview(p), []);

  // The URL id is the combined pair (aid1_aid2) by default → this response
  // carries `tiers[]`. A deep-linked tier id (aid1_aid2_kind) has no tiers[].
  const { data: combined, loading: pairLoading } = usePair(id);
  const tiers = combined?.tiers ?? [];

  // Reset the tier selection whenever we navigate to a different pair.
  useEffect(() => { setSelectedKind(null); setTradesPage(0); }, [id]);
  // Switching tier swaps the underlying dataset → restart trade pagination.
  useEffect(() => { setTradesPage(0); }, [selectedKind]);

  // When a specific tier is picked, fetch that tier; otherwise show combined.
  const tierId = selectedKind !== null && combined
    ? pairUrlId(combined.aid1, combined.aid2, selectedKind)
    : undefined;
  const { data: tierPair } = usePair(tierId);
  const pair = (selectedKind !== null ? tierPair : null) ?? combined;
  // Drives chart + trades: the selected tier, else the combined pair.
  const dataId = tierId ?? id;
  // OPT_COLOR for the pooled-token icons (header pair icons use IconsPair,
  // which resolves colours itself). Computed before the loading guard below.
  const poolColor1 = useAssetColor(pair?.aid1);
  const poolColor2 = useAssetColor(pair?.aid2);

  // MC mode requires USD-denominated candles; force it implicitly.
  const effectiveDenom: Denom = metric === 'mc' ? 'usd' : denom;
  const setDenom = (d: Denom): void => {
    setDenom_(d);
    // Switching denom should drop MC if we're leaving USD.
    if (d !== 'usd' && metric === 'mc') setMetric('price');
  };

  const { candles: rawCandles, loadOlder, hasMore: chartHasMore } = useOhlcv(dataId, { interval, denom: effectiveDenom, limit: 500 });

  // For BEAM/X pairs we chart MC of the non-BEAM side; for X/Y MC is ambiguous
  // (which side?) so the toggle is hidden and this resolves to `undefined`.
  const nonBeamAid = pair
    ? pair.aid1 === 0 ? pair.aid2 : pair.aid2 === 0 ? pair.aid1 : undefined
    : undefined;
  const nonBeamDecimals = pair && nonBeamAid !== undefined
    ? (pair.aid1 === nonBeamAid ? pair.decimals1 : pair.decimals2)
    : 8;
  const { data: assetHistory } = useAssetHistory(
    metric === 'mc' && nonBeamAid !== undefined ? nonBeamAid : undefined,
  );

  // Sorted [ts, supply] timeline for the non-BEAM asset. Each event records
  // cumulative supply *after* that event, so for candle at time T we want
  // the latest event with ts <= T.
  const supplyTimeline = useMemo<Array<[number, number]>>(() => {
    if (!assetHistory) return [];
    return assetHistory.history
      .filter((h) => h.ts !== null && h.total_amount !== null)
      .map<[number, number]>((h) => [h.ts as number, Number(h.total_amount) / 10 ** nonBeamDecimals])
      .sort((a, b) => a[0] - b[0]);
  }, [assetHistory, nonBeamDecimals]);

  // Inverting USD makes little sense (USD/aid1 → aid1/USD), so flip is gated
  // to native mode. Keep `flipChart` state across denom changes — toggling
  // back to native restores the user's preferred orientation. Flip is also
  // disabled in MC mode (we're charting a single asset's market cap).
  const chartFlipped = flipChart && effectiveDenom === 'native' && metric === 'price';
  const candles = useMemo<ApiCandle[]>(() => {
    // Fill no-trade buckets first so the flip/MC transforms below carry through
    // to the synthetic candles too (a flat candle inverts/scales to a flat one).
    let out = densifyCandles(rawCandles, INTERVAL_SECONDS[interval]);
    if (chartFlipped) {
      out = out.map((c) => ({
        ...c,
        open: c.open !== 0 ? 1 / c.open : 0,
        close: c.close !== 0 ? 1 / c.close : 0,
        // Inverted high/low swap: 1/min becomes new max, 1/max becomes new min.
        high: c.low !== 0 ? 1 / c.low : 0,
        low: c.high !== 0 ? 1 / c.high : 0,
      }));
    }
    if (metric === 'mc' && supplyTimeline.length > 0) {
      // Walk the supply timeline in lockstep with the (sorted) candles via a
      // moving cursor — O(n+m) instead of O(n log m).
      let cursor = 0;
      out = out.map((c) => {
        const t = c.time as number;
        while (cursor + 1 < supplyTimeline.length && supplyTimeline[cursor + 1]![0] <= t) cursor++;
        const supply = supplyTimeline[cursor] && supplyTimeline[cursor]![0] <= t
          ? supplyTimeline[cursor]![1]
          : null;
        if (supply === null) {
          return {
            ...c, open: 0, high: 0, low: 0, close: 0,
          };
        }
        return {
          ...c,
          open: c.open * supply,
          high: c.high * supply,
          low: c.low * supply,
          close: c.close * supply,
        };
      });
    }
    return out;
  }, [rawCandles, chartFlipped, metric, supplyTimeline, interval]);
  const { items: tradeItems, total: tradesTotal } = usePagedTrades(dataId, tradesPage, TRADES_PAGE_SIZE);

  if (pairLoading || !pair) {
    return <Loading>Loading pair…</Loading>;
  }

  const p: ApiPair = pair;
  const totalTxns = (p.buys_24h ?? 0) + (p.sells_24h ?? 0);
  const buyPct = totalTxns > 0 ? (p.buys_24h / totalTxns) * 100 : 50;

  const chg24 = fmtPct(p.price_change_24h);
  // Native price is `aid2 per aid1` — values are in the quote unit (symbol2).
  // When flipped, we invert each candle and the legend unit becomes symbol1.
  const sym1 = p.symbol1 ?? `aid${p.aid1}`;
  const sym2 = p.symbol2 ?? `aid${p.aid2}`;
  const nativeUnit = chartFlipped ? sym1 : sym2;
  const denomSym = metric === 'mc'
    ? `MC ${(p.aid1 === 0 ? sym2 : sym1)} USD`
    : effectiveDenom === 'usd' ? 'USD' : nativeUnit;

  const isBeamPair = p.aid1 === 0 || p.aid2 === 0;

  return (
    <Page>
      <AssetMetaBanner aid1={p.aid1} aid2={p.aid2} sym1={sym1} sym2={sym2} />
      <LiquidityBanner id={dataId ?? ''} pair={p} />
      <Layout>
      <Left>
        <TopBar>
          <BackBtn onClick={() => navigate(ROUTES.NAV.DEX)}>←</BackBtn>
          <IconsPair aid1={p.aid1} aid2={p.aid2} size={32} />
          <div>
            <TopTitle>
              {p.symbol1 ?? `aid${p.aid1}`}
              /
              {p.symbol2 ?? `aid${p.aid2}`}
              {' '}
              {selectedKind === null && tiers.length > 1
                ? <TiersBadge kinds={tiers.map((t) => t.kind)} />
                : <KindBadge kind={p.kind} />}
            </TopTitle>
            <TopSubtitle>BEAM DEX</TopSubtitle>
          </div>
        </TopBar>

        {tiers.length > 1 && (
          <TierBar>
            <span className="lbl">Fee tier</span>
            <TierPill active={selectedKind === null} onClick={() => setSelectedKind(null)} title="Auto-route to the best pool per trade">
              Auto
            </TierPill>
            {tiers.map((t) => (
              <TierPill
                key={t.kind}
                active={selectedKind === t.kind}
                onClick={() => setSelectedKind(t.kind)}
              >
                {tierFeePct(t.kind).toFixed(2)}
                %
              </TierPill>
            ))}
          </TierBar>
        )}

        <ChartArea>
          <Toolbar>
            {INTERVALS.map((iv) => (
              <button
                key={iv}
                type="button"
                className={iv === interval ? 'active' : ''}
                onClick={() => setInterval_(iv)}
              >
                {iv}
              </button>
            ))}
            <div className="sep" />
            <button
              type="button"
              className={chartStyle === 'candle' ? 'active' : ''}
              onClick={() => setChartStyle('candle')}
            >
              Candle
            </button>
            <button
              type="button"
              className={chartStyle === 'area' ? 'active' : ''}
              onClick={() => setChartStyle('area')}
            >
              Area
            </button>
            {isBeamPair && (
              <>
                <div className="sep" />
                <button
                  type="button"
                  className={metric === 'price' ? 'active' : ''}
                  onClick={() => setMetric('price')}
                >
                  Price
                </button>
                <button
                  type="button"
                  className={metric === 'mc' ? 'active' : ''}
                  onClick={() => setMetric('mc')}
                  title={`Market cap of ${p.aid1 === 0 ? sym2 : sym1} (price×supply)`}
                >
                  MC
                </button>
                <div className="sep" />
                <button
                  type="button"
                  className={effectiveDenom === 'native' ? 'active' : ''}
                  onClick={() => setDenom('native')}
                  disabled={metric === 'mc'}
                  title={metric === 'mc' ? 'MC is USD-only' : undefined}
                >
                  {nativeUnit}
                </button>
                <button
                  type="button"
                  className={effectiveDenom === 'usd' ? 'active' : ''}
                  onClick={() => setDenom('usd')}
                >
                  USD
                </button>
              </>
            )}
            {effectiveDenom === 'native' && metric === 'price' && (
              <>
                <div className="sep" />
                <button
                  type="button"
                  onClick={() => setFlipChart((f) => !f)}
                  title={`Flip to ${chartFlipped ? `${sym2}/${sym1}` : `${sym1}/${sym2}`}`}
                >
                  {chartFlipped ? `${sym1}/${sym2}` : `${sym2}/${sym1}`}
                  {' '}
                  ⇄
                </button>
              </>
            )}
            <CenterOnDate>
              <input
                type="text"
                inputMode="numeric"
                spellCheck={false}
                autoComplete="off"
                placeholder="CENTER ON YYYY-MM-DD"
                value={centerOnDate}
                aria-label="Center chart on date (YYYY-MM-DD)"
                onChange={(e) => {
                  // Keep digits + dashes only; cap at YYYY-MM-DD length so
                  // the input matches what the picker would also emit.
                  const raw = e.target.value.replace(/[^0-9-]/g, '').slice(0, 10);
                  setCenterOnDate(raw);
                  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
                    if (!raw) setChartCenterOn(null);
                    return;
                  }
                  const ms = Date.parse(`${raw}T00:00:00Z`);
                  if (!Number.isNaN(ms)) setChartCenterOn(Math.floor(ms / 1000));
                }}
                onKeyDown={(e) => {
                  // Empty + Enter → reset the chart zoom to its default fit.
                  // (Setting centerOn=null on its own only stops centering; it
                  // doesn't un-zoom what a prior center already did.)
                  if (e.key === 'Enter' && centerOnDate === '') {
                    setChartCenterOn(null);
                    setChartFitNonce((n) => n + 1);
                  }
                }}
              />
              <span className="pickerBtn" title="Open date picker">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="3" y="4" width="18" height="17" rx="2" />
                  <line x1="3" y1="9" x2="21" y2="9" />
                  <line x1="8" y1="2" x2="8" y2="6" />
                  <line x1="16" y1="2" x2="16" y2="6" />
                </svg>
                <input
                  type="date"
                  value={centerOnDate}
                  tabIndex={-1}
                  aria-hidden="true"
                  onChange={(e) => {
                    const v = e.target.value; // YYYY-MM-DD
                    setCenterOnDate(v);
                    if (!v) { setChartCenterOn(null); return; }
                    const ms = Date.parse(`${v}T00:00:00Z`);
                    if (!Number.isNaN(ms)) setChartCenterOn(Math.floor(ms / 1000));
                  }}
                />
              </span>
            </CenterOnDate>
          </Toolbar>
          <ChartContainer>
            <Chart
              candles={candles}
              style={chartStyle}
              denomSymbol={denomSym}
              volumeDecimals={p.decimals1}
              volumeSymbol={sym1}
              onReachStart={chartHasMore ? loadOlder : undefined}
              centerOn={chartCenterOn}
              fitNonce={chartFitNonce}
              tradePreview={(() => {
                if (!tradePreview || metric !== 'price' || effectiveDenom !== 'native') return null;
                // Project the effective rate + signed impact into the chart's
                // Y-axis. SwapPanel gives us the impact in the canonical
                // aid1/aid2 frame; when the chart is showing aid2/aid1
                // (chartFlipped === false) the sign flips along with the
                // visible direction of the effective-rate line.
                const effChart  = chartFlipped ? 1 / tradePreview.effectiveRate : tradePreview.effectiveRate;
                const impactPct = chartFlipped ? tradePreview.impactPct         : -tradePreview.impactPct;
                const label = fmtPriceImpact(impactPct);
                return { effectiveRate: effChart, impactPct, label };
              })()}
            />
          </ChartContainer>
        </ChartArea>

        <TradesPanel>
          <FeedHeader>Recent Trades</FeedHeader>
          <TradesWrap>
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Type</th>
                  <th>Price USD</th>
                  <th>{p.symbol1}</th>
                  <th>{p.symbol2}</th>
                  <th>Value</th>
                </tr>
              </thead>
              <tbody>
                {tradeItems.map((t) => (
                  <tr key={t.trade_id} title={fmtDateFull(t.timestamp)}>
                    <td>{fmtDate(t.timestamp)}</td>
                    <td>
                      <span className={t.side === 'buy' ? 'buy' : 'sell'}>
                        {t.side === 'buy' ? 'Buy' : 'Sell'}
                      </span>
                    </td>
                    <td>{fmt$(t.price_usd)}</td>
                    <td>{fmtAmt(t.amount_in, p.decimals1)}</td>
                    <td>{fmtAmt(t.amount_out, p.decimals2)}</td>
                    <td>{fmt$(t.value_usd)}</td>
                  </tr>
                ))}
                {tradeItems.length === 0 && (
                  <tr>
                    <td colSpan={6} style={{ textAlign: 'center', padding: '24px 8px', color: 'rgba(255,255,255,0.4)' }}>
                      No trades yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </TradesWrap>
          <Pager
            page={tradesPage}
            pageSize={TRADES_PAGE_SIZE}
            total={tradesTotal}
            loadedCount={tradeItems.length}
            onChange={setTradesPage}
          />
        </TradesPanel>
      </Left>

      <Sidebar>
        <SidebarSection>
          <PriceRow>
            <span className="lbl">Price USD</span>
            <span className="lbl">
              Price
              {' '}
              {p.symbol1}
            </span>
          </PriceRow>
          <PriceRow>
            <span className="val">{fmt$(p.price_usd)}</span>
            <span className="native">
              {/* `Price (sym1)` means price denominated in sym1 — i.e.,
                  how many sym1 you get per 1 sym2. price_native is the
                  reverse (sym2 per sym1) so invert. */}
              {fmtPrice(p.price_native && p.price_native > 0 ? 1 / p.price_native : null)}
              {' '}
              {p.symbol1}
            </span>
          </PriceRow>
        </SidebarSection>

        <ChangeGrid>
          <div className="cell">
            <div className="lbl">24h</div>
            <div className={`val ${chg24.cls}`}>{chg24.text}</div>
          </div>
          <div className="cell">
            <div className="lbl">TVL</div>
            <div className="val">{fmt$(p.tvl_usd)}</div>
          </div>
          <div className="cell">
            <div className="lbl">Vol 24h</div>
            <div className="val">{fmt$(p.volume_24h_usd)}</div>
          </div>
          <div className="cell">
            <div className="lbl">Txns 24h</div>
            <div className="val">{p.trades_24h}</div>
          </div>
        </ChangeGrid>

        <SidebarSection>
          <h4>Txns 24h</h4>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
            <span style={{ fontFamily: 'SFProDisplay,monospace', fontWeight: 700 }}>{totalTxns}</span>
            <span style={{ color: '#00f6d2', fontFamily: 'SFProDisplay,monospace' }}>{p.buys_24h}</span>
            <span style={{ color: '#f25f5b', fontFamily: 'SFProDisplay,monospace' }}>{p.sells_24h}</span>
          </div>
          <TxnsBar>
            <div className="buy-fill" style={{ width: `${buyPct}%` }} />
            <div className="sell-fill" style={{ width: `${100 - buyPct}%` }} />
          </TxnsBar>
        </SidebarSection>

        <SidebarSection>
          <h4>Pooled Tokens</h4>
          <PoolRow>
            <div className="name">
              <PoolAssetIcon asset_id={p.aid1} size={20} color={poolColor1} />
              <span className="lbl">
                {p.symbol1 ?? `aid${p.aid1}`}
                {' '}
                <small>
                  (#
                  {p.aid1}
                  )
                </small>
              </span>
            </div>
            <span className="val">
              {fmtNum(p.reserve1_human, 2)}
              <span className="usd">{fmt$(p.reserve1_usd)}</span>
            </span>
          </PoolRow>
          <PoolRow>
            <div className="name">
              <PoolAssetIcon asset_id={p.aid2} size={20} color={poolColor2} />
              <span className="lbl">
                {p.symbol2 ?? `aid${p.aid2}`}
                {' '}
                <small>
                  (#
                  {p.aid2}
                  )
                </small>
              </span>
            </div>
            <span className="val">
              {fmtNum(p.reserve2_human, 2)}
              <span className="usd">{fmt$(p.reserve2_usd)}</span>
            </span>
          </PoolRow>
        </SidebarSection>

        <SidebarSection>
          <h4>Pair Info</h4>
          <StatRow>
            <span className="lbl">LP Token</span>
            <span className="val">
              aid #
              {p.lp_token}
            </span>
          </StatRow>
          <StatRow>
            <span className="lbl">Fee tier</span>
            <span className="val">
              {selectedKind === null && tiers.length > 1
                ? `Auto · ${tiers.map((t) => `${tierFeePct(t.kind).toFixed(2)}%`).join(' / ')}`
                : `${tierFeePct(p.kind).toFixed(2)}%`}
            </span>
          </StatRow>
          <StatRow>
            <span className="lbl">Rate</span>
            <RateLine>
              <FlipRateBtn type="button" onClick={() => setFlipRate((f) => !f)} title="Flip">⇄</FlipRateBtn>
              <span>
                1
                {' '}
                {flipRate ? p.symbol2 : p.symbol1}
                {' '}
                =
                {' '}
                {fmtPrice(flipRate ? 1 / (p.price_native ?? 1) : p.price_native)}
                {' '}
                {flipRate ? p.symbol1 : p.symbol2}
              </span>
            </RateLine>
          </StatRow>
        </SidebarSection>

        <SwapPanel
          pair={p}
          tiers={selectedKind === null ? combined?.tiers : undefined}
          onPreviewChange={onPreviewChange}
        />
      </Sidebar>
      </Layout>
    </Page>
  );
};

function fmtAmt(s: string | null | undefined, decimals: number): string {
  if (!s) return '0';
  // NOTE: BigInt math was used originally for precision, but our Babel target
  // transpiles `**` into `Math.pow(...)`, which throws on BigInts. Switch to
  // plain Number — amounts here fit comfortably in MAX_SAFE_INTEGER for any
  // realistic trade (and we're truncating to display precision anyway).
  const n = Number(s) / 10 ** decimals;
  if (!Number.isFinite(n)) return s;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  if (n >= 1) return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (n === 0) return '0';
  const dec = Math.min(decimals, 6);
  return n.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
