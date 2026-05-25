import React, { useMemo, useState } from 'react';
import { styled } from '@linaria/react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  usePair, useOhlcv, useTradeFeed, useAssetHistory,
} from '../hooks';
import type {
  ApiCandle, ApiPair, Interval, Denom,
} from '../api/types';
import { Chart } from '../components/Chart';
import { IconsPair } from '../components/IconsPair';
import { KindBadge } from '../components/KindBadge';
import { SwapPanel } from '../components/SwapPanel';
import {
  fmt$, fmtPct, fmtPrice, fmtDate, fmtDateFull, fmtNum,
} from '../components/format';

const INTERVALS: Interval[] = ['1m', '5m', '15m', '1h', '4h', '1d'];

// Per-tier fee % for display alongside the rate.
const TIER_FEE_PCT: Record<number, number> = { 0: 0.05, 1: 0.3, 2: 1 };

const Layout = styled.div`
  display: grid;
  grid-template-columns: 1fr 320px;
  gap: 0;
  min-height: calc(100vh - 130px);
  width: 100%;
  max-width: 100%;
  overflow: hidden;

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
  gap: 12px;
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
  gap: 4px;
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

const ChartContainer = styled.div`
  flex: 1;
  min-height: 360px;
  position: relative;
`;

const TradesPanel = styled.div`
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  min-width: 0;
`;

const Tabs = styled.div`
  display: flex;
  align-items: stretch;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  button {
    padding: 10px 16px;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: rgba(255, 255, 255, 0.5);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    font-family: inherit;
    &.active {
      color: white;
      border-bottom-color: var(--color-green);
    }
    &:hover {
      color: rgba(255, 255, 255, 0.8);
    }
  }
  .spacer { flex: 1; }
  .collapse {
    padding: 6px 12px;
    margin: auto 8px;
    background: rgba(255, 255, 255, 0.04);
    border: none;
    border-radius: 4px;
    color: rgba(255, 255, 255, 0.55);
    font-size: 11px;
    cursor: pointer;
    font-family: inherit;
    line-height: 1;
    &:hover { background: rgba(255, 255, 255, 0.1); color: white; }
  }
`;

const TradesWrap = styled.div`
  max-height: 220px;
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
  gap: 8px;
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
  gap: 8px;
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

const RateLine = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
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

export const PairDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [interval, setInterval_] = useState<Interval>('1h');
  const [chartStyle, setChartStyle] = useState<'candle' | 'area'>('candle');
  const [metric, setMetric] = useState<'price' | 'mc'>('price');
  const [denom, setDenom_] = useState<Denom>('native');
  // Default to inverted (aid1-per-aid2): the rest of the UI — pair title
  // "sym1/sym2", PRICE column, MC — all describe aid2 (the non-BEAM side).
  // Charting native (aid2-per-aid1) by default trends in the opposite
  // direction from what the title implies. Keep the toggle for users who
  // want the raw native quote.
  const [flipChart, setFlipChart] = useState(true);
  const [tab, setTab] = useState<'trades' | 'lp'>('trades');
  const [feedCollapsed, setFeedCollapsed] = useState(false);
  const [flipRate, setFlipRate] = useState(false);

  const { data: pair, loading: pairLoading } = usePair(id);

  // MC mode requires USD-denominated candles; force it implicitly.
  const effectiveDenom: Denom = metric === 'mc' ? 'usd' : denom;
  const setDenom = (d: Denom): void => {
    setDenom_(d);
    // Switching denom should drop MC if we're leaving USD.
    if (d !== 'usd' && metric === 'mc') setMetric('price');
  };

  const { candles: rawCandles, loadOlder, hasMore: chartHasMore } = useOhlcv(id, { interval, denom: effectiveDenom, limit: 500 });

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
    let out = rawCandles;
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
  }, [rawCandles, chartFlipped, metric, supplyTimeline]);
  const feedKind = tab === 'lp' ? 'lp' : 'Trade';
  const {
    items: feedItems, loading: feedLoading, hasMore: feedHasMore, loadMore: feedLoadMore,
  } = useTradeFeed(id, feedKind, 50);

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
    <Layout>
      <Left>
        <TopBar>
          <BackBtn onClick={() => navigate('/pairs')}>←</BackBtn>
          <IconsPair aid1={p.aid1} aid2={p.aid2} size={32} />
          <div>
            <TopTitle>
              {p.symbol1 ?? `aid${p.aid1}`}
              /
              {p.symbol2 ?? `aid${p.aid2}`}
              {' '}
              <KindBadge kind={p.kind} />
            </TopTitle>
            <TopSubtitle>BEAM DEX</TopSubtitle>
          </div>
        </TopBar>

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
          </Toolbar>
          <ChartContainer>
            <Chart
              candles={candles}
              style={chartStyle}
              denomSymbol={denomSym}
              volumeDecimals={p.decimals1}
              volumeSymbol={sym1}
              onReachStart={chartHasMore ? loadOlder : undefined}
            />
          </ChartContainer>
        </ChartArea>

        <TradesPanel>
          <Tabs>
            <button type="button" className={tab === 'trades' ? 'active' : ''} onClick={() => setTab('trades')}>
              Trades
            </button>
            <button type="button" className={tab === 'lp' ? 'active' : ''} onClick={() => setTab('lp')}>
              LP
            </button>
            <div className="spacer" />
            <button
              type="button"
              className="collapse"
              onClick={() => setFeedCollapsed((v) => !v)}
              title={feedCollapsed ? 'Expand' : 'Collapse'}
            >
              {feedCollapsed ? '▲ Expand' : '▼ Collapse'}
            </button>
          </Tabs>
          {!feedCollapsed && (
          <TradesWrap>
            <table>
              <thead>
                {tab === 'trades' ? (
                  <tr>
                    <th>Date</th>
                    <th>Type</th>
                    <th>Price USD</th>
                    <th>{p.symbol1}</th>
                    <th>{p.symbol2}</th>
                    <th>Value</th>
                  </tr>
                ) : (
                  <tr>
                    <th>Date</th>
                    <th>Type</th>
                    <th>{p.symbol1}</th>
                    <th>{p.symbol2}</th>
                    <th>LP</th>
                  </tr>
                )}
              </thead>
              <tbody>
                {tab === 'trades'
                  ? feedItems.map((row) => {
                    const t = row as { trade_id: number; timestamp: number; side: 'buy' | 'sell'; price_usd: number | null; amount_in: string; amount_out: string; value_usd: number | null };
                    return (
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
                    );
                  })
                  : feedItems.map((row) => {
                    const e = row as { event_id: number; timestamp: number; kind: 'Deposit' | 'Withdraw'; amount1: string; amount2: string; amount_ctl: string };
                    return (
                      <tr key={e.event_id}>
                        <td>{fmtDate(e.timestamp)}</td>
                        <td>
                          <span className={e.kind === 'Deposit' ? 'buy' : 'sell'}>
                            {e.kind}
                          </span>
                        </td>
                        <td>{fmtAmt(e.amount1, p.decimals1)}</td>
                        <td>{fmtAmt(e.amount2, p.decimals2)}</td>
                        <td>{fmtAmt(e.amount_ctl, 8)}</td>
                      </tr>
                    );
                  })}
                {feedItems.length === 0 && !feedLoading && (
                  <tr>
                    <td colSpan={tab === 'trades' ? 6 : 5} style={{ textAlign: 'center', padding: '24px 8px', color: 'rgba(255,255,255,0.4)' }}>
                      No
                      {' '}
                      {tab === 'trades' ? 'trades' : 'LP events'}
                      {' '}
                      yet.
                    </td>
                  </tr>
                )}
                {feedHasMore && feedItems.length > 0 && (
                  <tr>
                    <td colSpan={tab === 'trades' ? 6 : 5} style={{ textAlign: 'center', padding: '8px' }}>
                      <button
                        type="button"
                        onClick={feedLoadMore}
                        disabled={feedLoading}
                        style={{
                          background: 'rgba(255,255,255,0.06)',
                          color: 'rgba(255,255,255,0.7)',
                          border: 'none',
                          padding: '6px 14px',
                          borderRadius: 6,
                          fontSize: 12,
                          cursor: feedLoading ? 'wait' : 'pointer',
                          fontFamily: 'inherit',
                        }}
                      >
                        {feedLoading ? 'Loading…' : 'Load older'}
                      </button>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </TradesWrap>
          )}
        </TradesPanel>
      </Left>

      <Sidebar>
        <SidebarSection>
          <PriceRow>
            <span className="lbl">Price USD</span>
            <span className="lbl">
              Price
              {p.symbol1}
            </span>
          </PriceRow>
          <PriceRow>
            <span className="val">{fmt$(p.price_usd)}</span>
            <span className="native">
              {fmtPrice(p.price_native)}
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
            <span className="lbl">
              {p.symbol1 ?? `aid${p.aid1}`}
              {' '}
              <small>
                (#
                {p.aid1}
                )
              </small>
            </span>
            <span className="val">
              {fmtNum(p.reserve1_human, 2)}
              <span className="usd">{fmt$(p.reserve1_usd)}</span>
            </span>
          </PoolRow>
          <PoolRow>
            <span className="lbl">
              {p.symbol2 ?? `aid${p.aid2}`}
              {' '}
              <small>
                (#
                {p.aid2}
                )
              </small>
            </span>
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
              {(TIER_FEE_PCT[p.kind] ?? 0).toFixed(2)}
              %
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

        <SwapPanel pair={p} />
      </Sidebar>
    </Layout>
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
