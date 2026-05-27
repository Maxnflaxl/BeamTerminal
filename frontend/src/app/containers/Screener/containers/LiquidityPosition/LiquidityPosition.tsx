import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { styled } from '@linaria/react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../../api/client';
import type { ApiDepositInfo, ApiPair } from '../../api/types';
import {
  computeMetrics,
  computePnl,
  computeHypo,
  fmtAmount,
  fmtPct,
  fmtDuration,
  assetName,
  type Metrics,
  type Unit,
} from './compute';
import { ILCurveChart } from './charts/ILCurveChart';
import { ScenariosChart } from './charts/ScenariosChart';
import { SimulatorChart } from './charts/SimulatorChart';

// ---------------------------------------------------------------------------
// Styling — mirrors the dark cards used across the Screener (#042548 panels).
// ---------------------------------------------------------------------------

const Page = styled.div`
  max-width: 1100px;
  margin: 0 auto;
  padding: 20px;
  /* Fill the viewport so the global footer stays pinned to the bottom even on
     the short empty state (matches PairsList / AssetsList / PairDetail). */
  min-height: calc(100vh - 130px);
  @media (max-width: 640px) { padding: 12px; }
`;

const Title = styled.h1`
  font-size: 20px;
  font-weight: 600;
  color: #fff;
  margin: 4px 0 4px;
`;

const Sub = styled.p`
  font-size: 13px;
  color: rgba(255, 255, 255, 0.55);
  margin: 0 0 16px;
  max-width: 720px;
  & a { color: #00f6d2; text-decoration: none; }
  & a:hover { text-decoration: underline; }
`;

const SearchRow = styled.form`
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
  position: relative;
`;

const Field = styled.input`
  flex: 1;
  min-width: 240px;
  padding: 9px 12px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  color: white;
  font-size: 13px;
  font-family: inherit;
  outline: none;
  &:focus { border-color: var(--color-green); }
`;

const Btn = styled.button`
  padding: 9px 16px;
  background: rgba(0, 246, 210, 0.15);
  border: 1px solid rgba(0, 246, 210, 0.5);
  border-radius: 8px;
  color: #00f6d2;
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  white-space: nowrap;
  &:hover { background: rgba(0, 246, 210, 0.25); }
  &:disabled { opacity: 0.5; cursor: default; }
`;

const GhostBtn = styled.button`
  padding: 9px 12px;
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 8px;
  color: rgba(255, 255, 255, 0.7);
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  &:hover { border-color: var(--color-green); color: #00f6d2; }
`;

const Message = styled.div`
  margin-top: 16px;
  padding: 12px 14px;
  border-radius: 8px;
  font-size: 13px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.7);
  &[data-err='1'] { border-color: rgba(255, 99, 99, 0.5); color: #ff9b9b; }
`;

const Grid = styled.div`
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  margin-top: 16px;
  @media (max-width: 760px) { grid-template-columns: 1fr; }
`;

const Card = styled.div`
  background: #042548;
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 10px;
  padding: 14px 16px;
`;

const WideCard = styled(Card)`
  grid-column: 1 / -1;
`;

const CardHead = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
`;

const CardTitle = styled.h3`
  font-size: 12px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: rgba(255, 255, 255, 0.55);
  margin: 0;
`;

const SwapBtn = styled.button`
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 6px;
  color: rgba(255, 255, 255, 0.6);
  font-size: 11px;
  padding: 2px 8px;
  cursor: pointer;
  &:hover { color: #00f6d2; border-color: rgba(0, 246, 210, 0.5); }
`;

const Row = styled.div<{ sep?: boolean }>`
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  padding: 5px 0;
  font-size: 13px;
  border-top: ${(p) => (p.sep ? '1px solid rgba(255,255,255,0.06)' : 'none')};
  margin-top: ${(p) => (p.sep ? '4px' : '0')};
  padding-top: ${(p) => (p.sep ? '9px' : '5px')};
`;

const Label = styled.span`
  color: rgba(255, 255, 255, 0.55);
`;

const Value = styled.span<{ pos?: boolean; neg?: boolean }>`
  color: ${(p) => (p.pos ? '#36e0a0' : p.neg ? '#ff9b9b' : '#fff')};
  font-variant-numeric: tabular-nums;
  text-align: right;
  & small { color: rgba(255, 255, 255, 0.4); margin-left: 4px; }
`;

const Tabs = styled.div`
  display: flex;
  gap: 6px;
`;

const Tab = styled.button<{ active?: boolean }>`
  padding: 4px 10px;
  font-size: 12px;
  font-family: inherit;
  border-radius: 6px;
  cursor: pointer;
  background: ${(p) => (p.active ? 'rgba(0,246,210,0.18)' : 'transparent')};
  color: ${(p) => (p.active ? '#00f6d2' : 'rgba(255,255,255,0.6)')};
  border: 1px solid ${(p) => (p.active ? 'rgba(0,246,210,0.5)' : 'rgba(255,255,255,0.12)')};
  &:hover { color: #00f6d2; }
`;

const Bookmarks = styled.div`
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  right: 0;
  z-index: 40;
  background: #021b35;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  padding: 6px;
  max-height: 260px;
  overflow: auto;
`;

const BmItem = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 8px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.8);
  &:hover { background: rgba(255, 255, 255, 0.06); }
  & .sub { color: rgba(255, 255, 255, 0.4); font-size: 11px; }
  & .del { background: transparent; border: none; color: rgba(255,255,255,0.4); cursor: pointer; font-size: 14px; }
  & .del:hover { color: #ff9b9b; }
`;

// ---------------------------------------------------------------------------

const KERNEL_RE = /^[0-9a-fA-F]{64}$/;
const HEIGHT_RE = /^\d+$/;
const BM_KEY = 'beam_lp_bookmarks';

type Bookmark = { search: string; label: string; height: number };

function loadBookmarks(): Bookmark[] {
  try {
    const raw = JSON.parse(localStorage.getItem(BM_KEY) || '[]') as unknown;
    if (!Array.isArray(raw)) return [];
    // Normalise + migrate legacy entries: the field was once `ref` (and older
    // builds may have stored other shapes), so fall back before discarding.
    return raw
      .map((b: { search?: unknown; ref?: unknown; label?: unknown; height?: unknown }) => ({
        search: String(b.search ?? b.ref ?? ''),
        label: String(b.label ?? ''),
        height: Number(b.height ?? 0),
      }))
      .filter((b) => b.search.length > 0);
  } catch {
    return [];
  }
}

function refParams(input: string): { kernel?: string; height?: number } | null {
  const v = (input ?? '').trim();
  if (KERNEL_RE.test(v)) return { kernel: v.toLowerCase() };
  if (HEIGHT_RE.test(v)) return { height: Number(v) };
  return null;
}

interface Loaded {
  deposit: ApiDepositInfo;
  pair: ApiPair;
  metrics: Metrics;
}

export const LiquidityPosition: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<ApiDepositInfo[] | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>(loadBookmarks);
  const [bmOpen, setBmOpen] = useState(false);

  // Unit toggles (asset 1 vs asset 2) — independent per block, as in the original.
  const [priceUnit, setPriceUnit] = useState<Unit>(1);
  const [pnlUnit, setPnlUnit] = useState<Unit>(1);
  const [hypoUnit, setHypoUnit] = useState<Unit>(1);
  const [analyticsUnit, setAnalyticsUnit] = useState<Unit>(1);
  const [tab, setTab] = useState<'il' | 'scenarios' | 'simulator'>('il');

  const buildFromDeposit = useCallback(async (deposit: ApiDepositInfo): Promise<void> => {
    const pair = await api.pair(deposit.lp_token);
    if (!pair.reserve1 || !pair.reserve2 || !pair.ctl_supply) {
      setError('This pool has no current state snapshot yet — cannot value the position.');
      return;
    }
    const metrics = computeMetrics({
      amount1: deposit.amount1,
      amount2: deposit.amount2,
      amountCtl: deposit.amount_ctl,
      decimals1: deposit.decimals1,
      decimals2: deposit.decimals2,
      reserve1: pair.reserve1,
      reserve2: pair.reserve2,
      ctlSupply: pair.ctl_supply,
      depositTs: deposit.ts,
      nowTs: Math.floor(Date.now() / 1000),
    });
    setLoaded({ deposit, pair, metrics });
    setCandidates(null);
  }, []);

  const runLookup = useCallback(
    async (raw: string): Promise<void> => {
      const params = refParams(raw);
      if (!params) {
        setError('Enter a 64-character kernel id or a block height.');
        return;
      }
      setLoading(true);
      setError(null);
      setCandidates(null);
      try {
        const res = await api.lpPosition.deposit(params);
        if ('candidates' in res) {
          setCandidates(res.candidates);
          setLoaded(null);
        } else {
          await buildFromDeposit(res);
          setSearchParams({ search: raw.trim() }, { replace: true });
        }
      } catch (e) {
        const msg = e instanceof ApiError ? e.message : 'Lookup failed. Please try again.';
        setError(msg);
        setLoaded(null);
      } finally {
        setLoading(false);
      }
    },
    [buildFromDeposit, setSearchParams],
  );

  // Deep-link: ?search=<kernel|height> auto-runs once on mount.
  useEffect(() => {
    const search = searchParams.get('search');
    if (search && !loaded && !loading) {
      setInput(search);
      void runLookup(search);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    void runLookup(input);
  };

  const isBookmarked = useMemo(
    () => loaded !== null && bookmarks.some((b) => b.search === (searchParams.get('search') ?? input.trim())),
    [bookmarks, loaded, searchParams, input],
  );

  const persistBookmarks = (next: Bookmark[]): void => {
    setBookmarks(next);
    localStorage.setItem(BM_KEY, JSON.stringify(next));
  };

  const toggleBookmark = (): void => {
    if (!loaded) return;
    const search = (searchParams.get('search') ?? input).trim();
    const exists = bookmarks.some((b) => b.search === search);
    if (exists) {
      persistBookmarks(bookmarks.filter((b) => b.search !== search));
    } else {
      const { deposit } = loaded;
      const label = `${assetName(deposit.aid1, deposit.symbol1)} / ${assetName(deposit.aid2, deposit.symbol2)}`;
      persistBookmarks([{ search, label, height: deposit.height }, ...bookmarks].slice(0, 30));
    }
  };

  return (
    <Page>
      <Title>Liquidity Positions</Title>
      <Sub>
        Analyse any Beam DEX liquidity position: paste the <b>kernel id</b> or the <b>block height</b> of
        your <i>Liquidity Add</i> transaction. Beam is confidential, so positions can&apos;t be listed —
        you supply the reference, and everything (share, fees, P&amp;L, impermanent loss) is computed from it.
        The app cannot know if the provided initial position has already been withdrawn (because the Beam
        blockchain is confidential!), so it assumes it is still currently in place.
        {' '}Developed by{' '}
        <a href="https://github.com/dbadol/BeamLiquidityPosition" target="_blank" rel="noopener noreferrer">dbadol</a>.
      </Sub>

      <SearchRow onSubmit={onSubmit}>
        <Field
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Kernel id (64 hex) or block height of the Liquidity Add"
          autoFocus
        />
        <Btn type="submit" disabled={loading}>
          {loading ? 'Looking up…' : 'Analyse'}
        </Btn>
        <GhostBtn type="button" onClick={() => setBmOpen((o) => !o)} title="Bookmarks">
          ★ {bookmarks.length || ''}
        </GhostBtn>
        {loaded && (
          <GhostBtn type="button" onClick={toggleBookmark} title={isBookmarked ? 'Remove bookmark' : 'Add bookmark'}>
            {isBookmarked ? 'Saved ✓' : 'Save'}
          </GhostBtn>
        )}
        {bmOpen && (
          <Bookmarks>
            {bookmarks.length === 0 ? (
              <BmItem><span className="sub">No bookmarks yet</span></BmItem>
            ) : (
              bookmarks.map((b) => (
                <BmItem
                  key={b.search}
                  onClick={() => {
                    setInput(b.search);
                    setBmOpen(false);
                    void runLookup(b.search);
                  }}
                >
                  <span>
                    {b.label}
                    <br />
                    <span className="sub">Block {b.height}</span>
                  </span>
                  <button
                    className="del"
                    onClick={(e) => {
                      e.stopPropagation();
                      persistBookmarks(bookmarks.filter((x) => x.search !== b.search));
                    }}
                  >
                    ×
                  </button>
                </BmItem>
              ))
            )}
          </Bookmarks>
        )}
      </SearchRow>

      {error && <Message data-err="1">{error}</Message>}

      {candidates && (
        <Message>
          Several deposits were indexed at that height — pick yours:
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {candidates.map((c, i) => (
              <GhostBtn key={i} type="button" onClick={() => void buildFromDeposit(c)} style={{ textAlign: 'left' }}>
                {assetName(c.aid1, c.symbol1)} / {assetName(c.aid2, c.symbol2)} ({c.kind_label}) —{' '}
                {fmtAmount(Number(c.amount1) / 10 ** c.decimals1)} {assetName(c.aid1, c.symbol1)} +{' '}
                {fmtAmount(Number(c.amount2) / 10 ** c.decimals2)} {assetName(c.aid2, c.symbol2)}
              </GhostBtn>
            ))}
          </div>
        </Message>
      )}

      {loaded && <Result loaded={loaded} priceUnit={priceUnit} setPriceUnit={setPriceUnit} pnlUnit={pnlUnit} setPnlUnit={setPnlUnit} hypoUnit={hypoUnit} setHypoUnit={setHypoUnit} analyticsUnit={analyticsUnit} setAnalyticsUnit={setAnalyticsUnit} tab={tab} setTab={setTab} />}
    </Page>
  );
};

// ---------------------------------------------------------------------------

interface ResultProps {
  loaded: Loaded;
  priceUnit: Unit;
  setPriceUnit: (u: Unit) => void;
  pnlUnit: Unit;
  setPnlUnit: (u: Unit) => void;
  hypoUnit: Unit;
  setHypoUnit: (u: Unit) => void;
  analyticsUnit: Unit;
  setAnalyticsUnit: (u: Unit) => void;
  tab: 'il' | 'scenarios' | 'simulator';
  setTab: (t: 'il' | 'scenarios' | 'simulator') => void;
}

const flip = (u: Unit): Unit => (u === 1 ? 2 : 1);

const Result: React.FC<ResultProps> = ({
  loaded,
  priceUnit,
  setPriceUnit,
  pnlUnit,
  setPnlUnit,
  hypoUnit,
  setHypoUnit,
  analyticsUnit,
  setAnalyticsUnit,
  tab,
  setTab,
}) => {
  const { deposit, pair, metrics: m } = loaded;
  const n1 = assetName(deposit.aid1, deposit.symbol1);
  const n2 = assetName(deposit.aid2, deposit.symbol2);

  const a1i = Number(deposit.amount1) / 10 ** deposit.decimals1;
  const a2i = Number(deposit.amount2) / 10 ** deposit.decimals2;

  // Price block — "1 <quote> = X <base>" with invert.
  const priceBase = priceUnit === 1 ? n1 : n2;
  const priceQuote = priceUnit === 1 ? n2 : n1;
  const initialPrice = priceUnit === 1 ? m.p2in1init : m.p1in2init;
  const poolPrice = priceUnit === 1 ? m.p2in1pool : m.p1in2pool;

  const pnl = computePnl(m, pnlUnit);
  const pnlName = pnlUnit === 1 ? n1 : n2;
  const hypo = computeHypo(m, hypoUnit);
  const hypoName = hypoUnit === 1 ? n1 : n2;
  const analyticsName = analyticsUnit === 1 ? n1 : n2;

  const depositDate = new Date(deposit.ts * 1000).toISOString().replace('T', ' ').slice(0, 19);

  return (
    <Grid>
      {/* INITIAL DEPOSIT */}
      <Card>
        <CardHead>
          <CardTitle>Initial deposit</CardTitle>
        </CardHead>
        <Row><Label>Block height</Label><Value>{deposit.height}<small>{depositDate} UTC</small></Value></Row>
        <Row><Label>{n1} deposited</Label><Value>{fmtAmount(a1i)}<small>{n1}</small></Value></Row>
        <Row><Label>{n2} deposited</Label><Value>{fmtAmount(a2i)}<small>{n2}</small></Value></Row>
        <Row><Label>LP tokens received</Label><Value>{fmtAmount(Number(deposit.amount_ctl) / 1e8)}<small>aid {deposit.aid_ctl}</small></Value></Row>
        <Row sep>
          <Label>Initial price <SwapBtn onClick={() => setPriceUnit(flip(priceUnit))}>⇄</SwapBtn></Label>
          <Value>1 {priceQuote} = {fmtAmount(initialPrice)} {priceBase}</Value>
        </Row>
      </Card>

      {/* CURRENT POOL */}
      <Card>
        <CardHead><CardTitle>Current pool</CardTitle></CardHead>
        <Row><Label>Snapshot height</Label><Value>{pair.snapshot_height ?? '–'}</Value></Row>
        <Row><Label>Fee tier</Label><Value>{deposit.kind_label} ({deposit.fee_pct}%)</Value></Row>
        <Row><Label>Total {n1}</Label><Value>{fmtAmount(m.a1p)}<small>{n1}</small></Value></Row>
        <Row><Label>Total {n2}</Label><Value>{fmtAmount(m.a2p)}<small>{n2}</small></Value></Row>
        <Row><Label>Total LP supply</Label><Value>{fmtAmount(Number(pair.ctl_supply) / 1e8)}<small>aid {deposit.aid_ctl}</small></Value></Row>
        <Row sep>
          <Label>Current price <SwapBtn onClick={() => setPriceUnit(flip(priceUnit))}>⇄</SwapBtn></Label>
          <Value>1 {priceQuote} = {fmtAmount(poolPrice)} {priceBase}</Value>
        </Row>
      </Card>

      {/* CURRENT POSITION */}
      <Card>
        <CardHead><CardTitle>Current position</CardTitle></CardHead>
        <Row><Label>Share of the pool</Label><Value>{fmtPct(m.share, 4).replace('+', '')}</Value></Row>
        <Row sep><Label>Principal {n1}</Label><Value>{fmtAmount(m.aid1Principal)}<small>{n1}</small></Value></Row>
        <Row><Label>+ Fees earned {n1}</Label><Value pos={m.aid1Fees >= 0} neg={m.aid1Fees < 0}>{fmtAmount(m.aid1Fees)}<small>{n1}</small></Value></Row>
        <Row><Label>= Available {n1}</Label><Value>{fmtAmount(m.aid1Total)}<small>{n1}</small></Value></Row>
        <Row sep><Label>Principal {n2}</Label><Value>{fmtAmount(m.aid2Principal)}<small>{n2}</small></Value></Row>
        <Row><Label>+ Fees earned {n2}</Label><Value pos={m.aid2Fees >= 0} neg={m.aid2Fees < 0}>{fmtAmount(m.aid2Fees)}<small>{n2}</small></Value></Row>
        <Row><Label>= Available {n2}</Label><Value>{fmtAmount(m.aid2Total)}<small>{n2}</small></Value></Row>
      </Card>

      {/* PROFIT & LOSS */}
      <Card>
        <CardHead>
          <CardTitle>Profit &amp; Loss</CardTitle>
          <SwapBtn onClick={() => setPnlUnit(flip(pnlUnit))}>in {pnlName} ⇄</SwapBtn>
        </CardHead>
        <Row><Label>Time in the pool</Label><Value>{fmtDuration(m.durationMs)}</Value></Row>
        <Row sep><Label>Current worth</Label><Value>{fmtAmount(pnl.totalCurrent)}<small>{pnlName}</small></Value></Row>
        <Row><Label>− Initial worth</Label><Value>{fmtAmount(pnl.totalInitial)}<small>{pnlName}</small></Value></Row>
        <Row><Label>= Profit or Loss</Label><Value pos={pnl.profit >= 0} neg={pnl.profit < 0}>{fmtAmount(pnl.profit)}<small>{pnlName}</small></Value></Row>
        <Row sep><Label>ROI</Label><Value pos={pnl.roi >= 0} neg={pnl.roi < 0}>{fmtPct(pnl.roi)}</Value></Row>
        <Row><Label>Estimated APR</Label><Value pos={pnl.apr >= 0} neg={pnl.apr < 0}>{fmtPct(pnl.apr)}</Value></Row>
        <Row><Label>Price change ({pnlName})</Label><Value pos={pnl.priceChange >= 0} neg={pnl.priceChange < 0}>{fmtPct(pnl.priceChange)}</Value></Row>
      </Card>

      {/* HYPOTHETICALS */}
      <WideCard>
        <CardHead>
          <CardTitle>Hypotheticals</CardTitle>
          <SwapBtn onClick={() => setHypoUnit(flip(hypoUnit))}>in {hypoName} ⇄</SwapBtn>
        </CardHead>
        <Row><Label>Current worth (in pool)</Label><Value>{fmtAmount(hypo.current)}<small>{hypoName}</small></Value></Row>
        <Row sep><Label>1. If HODL the pair</Label><Value>{fmtAmount(hypo.hodl)}<small>{hypoName}</small></Value></Row>
        <Row><Label>Profit or Loss vs HODL (impermanent loss)</Label><Value pos={hypo.hodlDiff >= 0} neg={hypo.hodlDiff < 0}>{fmtAmount(hypo.hodlDiff)}<small>{hypoName}</small></Value></Row>
        <Row sep><Label>2. If HODL all in {n1}</Label><Value>{fmtAmount(hypo.allA1)}<small>{hypoName}</small></Value></Row>
        <Row><Label>Profit or Loss</Label><Value pos={hypo.allA1Diff >= 0} neg={hypo.allA1Diff < 0}>{fmtAmount(hypo.allA1Diff)}<small>{hypoName}</small></Value></Row>
        <Row sep><Label>3. If HODL all in {n2}</Label><Value>{fmtAmount(hypo.allA2)}<small>{hypoName}</small></Value></Row>
        <Row><Label>Profit or Loss</Label><Value pos={hypo.allA2Diff >= 0} neg={hypo.allA2Diff < 0}>{fmtAmount(hypo.allA2Diff)}<small>{hypoName}</small></Value></Row>
      </WideCard>

      {/* ANALYTICS */}
      <WideCard>
        <CardHead>
          <CardTitle>Analytics</CardTitle>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Tabs>
              <Tab active={tab === 'il'} onClick={() => setTab('il')}>IL curve</Tab>
              <Tab active={tab === 'scenarios'} onClick={() => setTab('scenarios')}>Scenarios</Tab>
              <Tab active={tab === 'simulator'} onClick={() => setTab('simulator')}>Simulator</Tab>
            </Tabs>
            <SwapBtn onClick={() => setAnalyticsUnit(flip(analyticsUnit))}>in {analyticsName} ⇄</SwapBtn>
          </div>
        </CardHead>
        {tab === 'il' && <ILCurveChart metrics={m} unit={analyticsUnit} name1={n1} name2={n2} />}
        {tab === 'scenarios' && <ScenariosChart metrics={m} unit={analyticsUnit} name1={n1} name2={n2} unitName={analyticsName} />}
        {tab === 'simulator' && <SimulatorChart metrics={m} unit={analyticsUnit} name1={n1} name2={n2} unitName={analyticsName} />}
      </WideCard>
    </Grid>
  );
};

export default LiquidityPosition;
