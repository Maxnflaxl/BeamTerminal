import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { styled } from '@linaria/react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../../api/client';
import type { ApiPair, ApiPoolEvents } from '../../api/types';
import {
  aggregate,
  computePnl,
  computeHypo,
  fmtAmount,
  fmtPct,
  fmtDuration,
  assetName,
  type Aggregate,
  type Unit,
  type ValUnit,
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
  max-width: 760px;
  & a { color: #00f6d2; text-decoration: none; }
  & a:hover { text-decoration: underline; }
`;

const SearchRow = styled.form`
  display: flex;
  & > * + * { margin-left: 8px; }
  flex-wrap: wrap;
  align-items: flex-start;
  position: relative;
`;

// Default to a single 40px line, level with the buttons; the resize handle lets
// the user expand it for long, multi-ref pastes.
const Field = styled.textarea`
  flex: 1;
  min-width: 240px;
  height: 40px;
  min-height: 40px;
  box-sizing: border-box;
  resize: vertical;
  padding: 9px 12px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  color: white;
  font-size: 13px;
  font-family: inherit;
  line-height: 20px;
  outline: none;
  &:focus { border-color: var(--color-green); }
`;

const Btn = styled.button`
  height: 40px;
  padding: 0 16px;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
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
  height: 40px;
  padding: 0 12px;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 8px;
  color: rgba(255, 255, 255, 0.7);
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  white-space: nowrap;
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

const Hints = styled.div`
  margin-top: 8px;
  font-size: 12px;
  line-height: 1.6;
  color: rgba(255, 255, 255, 0.45);
  & b { color: rgba(255, 255, 255, 0.7); font-weight: 600; }
  & code {
    font-family: 'SFMono-Regular', ui-monospace, monospace;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 4px;
    padding: 1px 6px;
    color: #00f6d2;
    word-break: break-all;
  }
  & .ex {
    margin-top: 6px;
    display: flex;
    flex-wrap: wrap;
    & > * + * { margin-left: 8px; }
    align-items: baseline;
  }
`;

const Picker = styled.div`
  margin-top: 16px;
  display: flex;
  flex-wrap: wrap;
  & > * + * { margin-left: 8px; }
  align-items: center;
`;

const PickerBtn = styled.button<{ active?: boolean }>`
  padding: 7px 12px;
  font-size: 12px;
  font-family: inherit;
  border-radius: 8px;
  cursor: pointer;
  background: ${(p) => (p.active ? 'rgba(0,246,210,0.18)' : 'rgba(255,255,255,0.04)')};
  color: ${(p) => (p.active ? '#00f6d2' : 'rgba(255,255,255,0.75)')};
  border: 1px solid ${(p) => (p.active ? 'rgba(0,246,210,0.5)' : 'rgba(255,255,255,0.12)')};
  &:hover { border-color: rgba(0, 246, 210, 0.5); }
  & small { color: rgba(255, 255, 255, 0.4); margin-left: 5px; }
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
  & > * + * { margin-left: 10px; }
  flex-wrap: wrap;
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
  & > * + * { margin-left: 12px; }
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

const BigPnl = styled.div<{ pos?: boolean }>`
  font-size: 26px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: ${(p) => (p.pos ? '#36e0a0' : '#ff9b9b')};
  margin: 4px 0 2px;
`;

const PnlSub = styled.div`
  font-size: 12px;
  color: rgba(255, 255, 255, 0.5);
  margin-bottom: 8px;
`;

const Tabs = styled.div`
  display: flex;
  & > * + * { margin-left: 6px; }
  flex-wrap: wrap;
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
  &:hover:not(:disabled) { color: #00f6d2; }
  &:disabled { opacity: 0.35; cursor: not-allowed; }
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
  & > * + * { margin-left: 8px; }
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

const BM_KEY = 'beam_lp_bookmarks';
type Bookmark = { search: string; label: string };

function loadBookmarks(): Bookmark[] {
  try {
    const raw = JSON.parse(localStorage.getItem(BM_KEY) || '[]') as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .map((b: { search?: unknown; ref?: unknown; label?: unknown }) => ({
        search: String(b.search ?? b.ref ?? ''),
        label: String(b.label ?? ''),
      }))
      .filter((b) => b.search.length > 0);
  } catch {
    return [];
  }
}

const flip = (u: Unit): Unit => (u === 1 ? 2 : 1);

function unitTabLabel(u: ValUnit, n1: string, n2: string): string {
  return u === 'aid1' ? n1 : u === 'aid2' ? n2 : u === 'beam' ? 'BEAM' : 'USD';
}

function fmtUnit(v: number, u: ValUnit, n1: string, n2: string): string {
  if (!Number.isFinite(v)) return '–';
  if (u === 'usd') return `${v < 0 ? '-$' : '$'}${fmtAmount(Math.abs(v))}`;
  return `${fmtAmount(v)} ${unitTabLabel(u, n1, n2)}`;
}

interface Loaded {
  pool: ApiPoolEvents;
  pair: ApiPair;
  agg: Aggregate;
}

export const LiquidityPosition: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unresolved, setUnresolved] = useState<string[]>([]);
  const [pools, setPools] = useState<ApiPoolEvents[] | null>(null);
  const [selectedLp, setSelectedLp] = useState<number | null>(null);
  const [pair, setPair] = useState<ApiPair | null>(null);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>(loadBookmarks);
  const [bmOpen, setBmOpen] = useState(false);

  const [unit, setUnit] = useState<ValUnit>('aid1');
  // Pair-asset toggles for the detailed remaining-position analysis.
  const [pnlUnit, setPnlUnit] = useState<Unit>(1);
  const [hypoUnit, setHypoUnit] = useState<Unit>(1);
  const [analyticsUnit, setAnalyticsUnit] = useState<Unit>(1);
  const [tab, setTab] = useState<'il' | 'scenarios' | 'simulator'>('il');

  const selectPool = useCallback(async (lpToken: number): Promise<void> => {
    setSelectedLp(lpToken);
    setPair(null);
    try {
      const p = await api.pair(lpToken);
      setPair(p);
    } catch {
      setError('Could not load the current pool state.');
    }
  }, []);

  const runLookup = useCallback(
    async (refs: string): Promise<void> => {
      const trimmed = refs.trim();
      if (!trimmed) {
        setError('Enter one or more block heights and/or kernel ids.');
        return;
      }
      setLoading(true);
      setError(null);
      setPools(null);
      setSelectedLp(null);
      setPair(null);
      try {
        const res = await api.lpPosition.events(trimmed);
        setUnresolved(res.unresolved);
        if (res.pools.length === 0) {
          setError('No liquidity add/remove found for those references.');
          return;
        }
        setPools(res.pools);
        if (res.pools.length === 1) await selectPool(res.pools[0]!.lp_token);
        setSearchParams({ search: trimmed }, { replace: true });
      } catch (e) {
        setError(e instanceof ApiError ? e.message : 'Lookup failed. Please try again.');
      } finally {
        setLoading(false);
      }
    },
    [selectPool, setSearchParams],
  );

  // Deep-link: ?search=<refs> auto-runs once on mount.
  useEffect(() => {
    const search = searchParams.get('search');
    if (search && !pools && !loading) {
      setInput(search);
      void runLookup(search);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedPool = useMemo(
    () => pools?.find((p) => p.lp_token === selectedLp) ?? null,
    [pools, selectedLp],
  );

  const loaded: Loaded | null = useMemo(() => {
    if (!selectedPool || !pair || !pair.reserve1 || !pair.reserve2 || !pair.ctl_supply) return null;
    const agg = aggregate({
      ops: selectedPool.events.map((e) => ({
        kind: e.kind,
        amount1: e.amount1,
        amount2: e.amount2,
        amountCtl: e.amount_ctl,
        ts: e.ts,
        beamPerAid1: e.beam_per_aid1,
        beamPerAid2: e.beam_per_aid2,
        usdPerAid1: e.usd_per_aid1,
        usdPerAid2: e.usd_per_aid2,
      })),
      decimals1: selectedPool.decimals1,
      decimals2: selectedPool.decimals2,
      reserve1: pair.reserve1,
      reserve2: pair.reserve2,
      ctlSupply: pair.ctl_supply,
      currentBeamPerAid1: selectedPool.current_beam_per_aid1,
      currentBeamPerAid2: selectedPool.current_beam_per_aid2,
      currentUsdPerAid1: selectedPool.current_usd_per_aid1,
      currentUsdPerAid2: selectedPool.current_usd_per_aid2,
      nowTs: Math.floor(Date.now() / 1000),
    });
    return { pool: selectedPool, pair, agg };
  }, [selectedPool, pair]);

  // Keep the active value-unit valid (fall back to asset 1 if unpriceable).
  useEffect(() => {
    if (loaded && !loaded.agg.flows[unit].available) setUnit('aid1');
  }, [loaded, unit]);

  const onSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    void runLookup(input);
  };

  const persistBookmarks = (next: Bookmark[]): void => {
    setBookmarks(next);
    localStorage.setItem(BM_KEY, JSON.stringify(next));
  };

  const currentRef = (searchParams.get('search') ?? input).trim();
  const isBookmarked = bookmarks.some((b) => b.search === currentRef);

  const toggleBookmark = (): void => {
    if (!currentRef) return;
    if (isBookmarked) {
      persistBookmarks(bookmarks.filter((b) => b.search !== currentRef));
    } else {
      const label = selectedPool
        ? `${assetName(selectedPool.aid1, selectedPool.symbol1)} / ${assetName(selectedPool.aid2, selectedPool.symbol2)}`
        : `${currentRef.split(/[\s,]+/).filter(Boolean).length} ref(s)`;
      persistBookmarks([{ search: currentRef, label }, ...bookmarks].slice(0, 30));
    }
  };

  return (
    <Page>
      <Title>Liquidity Positions</Title>
      <Sub>
        Analyse any Beam DEX liquidity position: paste the <b>kernel ids</b> and/or <b>block heights</b> of
        your <i>Liquidity Add</i> and <i>Liquidity Withdraw</i> transactions (one or many, any pools). Beam is
        confidential, so positions can&apos;t be listed — you supply the references, and everything (share,
        fees, P&amp;L, what&apos;s still in the pool) is computed from them. List your withdrawals too and it
        accounts for what you&apos;ve already taken out. Developed by{' '}
        <a href="https://github.com/dbadol/BeamLiquidityPosition" target="_blank" rel="noopener noreferrer">dbadol</a>.
      </Sub>

      <SearchRow onSubmit={onSubmit}>
        <Field
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="e.g.  3869854  or  a 64-character kernel id"
          rows={1}
          autoFocus
        />
        <Btn type="submit" disabled={loading}>{loading ? 'Looking up…' : 'Analyse'}</Btn>
        <GhostBtn type="button" onClick={() => setBmOpen((o) => !o)} title="Bookmarks">★ {bookmarks.length || ''}</GhostBtn>
        {pools && (
          <GhostBtn type="button" onClick={toggleBookmark}>{isBookmarked ? 'Saved ✓' : 'Save'}</GhostBtn>
        )}
        {bmOpen && (
          <Bookmarks>
            {bookmarks.length === 0 ? (
              <BmItem><span className="sub">No bookmarks yet</span></BmItem>
            ) : (
              bookmarks.map((b) => (
                <BmItem
                  key={b.search}
                  onClick={() => { setInput(b.search); setBmOpen(false); void runLookup(b.search); }}
                >
                  <span>
                    {b.label}
                    <br />
                    <span className="sub">{b.search.length > 40 ? `${b.search.slice(0, 40)}…` : b.search}</span>
                  </span>
                  <button
                    className="del"
                    onClick={(e) => { e.stopPropagation(); persistBookmarks(bookmarks.filter((x) => x.search !== b.search)); }}
                  >
                    ×
                  </button>
                </BmItem>
              ))
            )}
          </Bookmarks>
        )}
      </SearchRow>

      <Hints>
        Paste the <b>Kernel ID</b> (64 hex characters) or the <b>block height</b> of each of your{' '}
        <i>Liquidity Add</i> and <i>Liquidity Withdraw</i> transactions — both are in your BEAM
        wallet&apos;s transaction details, or on a Beam block explorer. List as many as you like,
        separated by commas, spaces or new lines; adds and removes can be mixed.
        <div className="ex">
          <span>Examples:</span>
          <code>3869854</code>
          <span>(block height)</span>
          <code>631bd48138edf72c3e7a570242563e049abf68b267eb2ea8748e927455c8e905</code>
          <span>(kernel id)</span>
        </div>
      </Hints>

      {error && <Message data-err="1">{error}</Message>}
      {unresolved.length > 0 && (
        <Message>Couldn&apos;t resolve {unresolved.length} reference(s): {unresolved.join(', ')}</Message>
      )}

      {pools && pools.length > 1 && (
        <Picker>
          <Label>Pool:</Label>
          {pools.map((p) => (
            <PickerBtn key={p.lp_token} active={p.lp_token === selectedLp} onClick={() => void selectPool(p.lp_token)}>
              {assetName(p.aid1, p.symbol1)} / {assetName(p.aid2, p.symbol2)}
              <small>{p.kind_label} · {p.events.length} op{p.events.length > 1 ? 's' : ''}</small>
            </PickerBtn>
          ))}
        </Picker>
      )}

      {selectedPool && pair && !loaded && (
        <Message data-err="1">This pool has no current state snapshot yet — can&apos;t value the position.</Message>
      )}

      {loaded && (
        <Result
          loaded={loaded}
          unit={unit}
          setUnit={setUnit}
          pnlUnit={pnlUnit}
          setPnlUnit={setPnlUnit}
          hypoUnit={hypoUnit}
          setHypoUnit={setHypoUnit}
          analyticsUnit={analyticsUnit}
          setAnalyticsUnit={setAnalyticsUnit}
          tab={tab}
          setTab={setTab}
        />
      )}
    </Page>
  );
};

// ---------------------------------------------------------------------------

interface ResultProps {
  loaded: Loaded;
  unit: ValUnit;
  setUnit: (u: ValUnit) => void;
  pnlUnit: Unit;
  setPnlUnit: (u: Unit) => void;
  hypoUnit: Unit;
  setHypoUnit: (u: Unit) => void;
  analyticsUnit: Unit;
  setAnalyticsUnit: (u: Unit) => void;
  tab: 'il' | 'scenarios' | 'simulator';
  setTab: (t: 'il' | 'scenarios' | 'simulator') => void;
}

const VALUE_UNITS: ValUnit[] = ['aid1', 'aid2', 'beam', 'usd'];

const Result: React.FC<ResultProps> = ({
  loaded,
  unit,
  setUnit,
  pnlUnit,
  setPnlUnit,
  hypoUnit,
  setHypoUnit,
  analyticsUnit,
  setAnalyticsUnit,
  tab,
  setTab,
}) => {
  const { pool, pair, agg } = loaded;
  const n1 = assetName(pool.aid1, pool.symbol1);
  const n2 = assetName(pool.aid2, pool.symbol2);
  const flow = agg.flows[unit];
  const m = agg.metrics;

  // Without any Liquidity Add there's no cost basis, so P&L/remaining are
  // meaningless — guide the user instead of showing inflated numbers.
  if (agg.addsCount === 0) {
    return (
      <Message data-err="1">
        These references only contain withdrawals (no <i>Liquidity Add</i>). Add the kernel id or block
        height of your deposit(s) to compute P&amp;L and the remaining position.
      </Message>
    );
  }

  return (
    <>
      {/* Position summary — flow accounting, valuable in any of the 4 units. */}
      <Grid>
        <WideCard>
          <CardHead>
            <CardTitle>Position summary</CardTitle>
            <Tabs>
              {VALUE_UNITS.map((u) => (
                <Tab
                  key={u}
                  active={unit === u}
                  disabled={!agg.flows[u].available}
                  onClick={() => setUnit(u)}
                  title={agg.flows[u].available ? '' : 'No BEAM route for this pair'}
                >
                  {unitTabLabel(u, n1, n2)}
                </Tab>
              ))}
            </Tabs>
          </CardHead>

          {flow.available ? (
            <>
              <BigPnl pos={flow.pnl >= 0}>{flow.pnl >= 0 ? '+' : ''}{fmtUnit(flow.pnl, unit, n1, n2)}</BigPnl>
              <PnlSub>
                net profit / loss · {fmtUnit(flow.remaining, unit, n1, n2)} still in the pool
                {flow.invested > 0 ? ` · ROI ${fmtPct(flow.pnl / flow.invested)}` : ''}
              </PnlSub>
              <Row sep><Label>Invested ({agg.addsCount} add{agg.addsCount === 1 ? '' : 's'})</Label><Value>{fmtUnit(flow.invested, unit, n1, n2)}</Value></Row>
              {agg.hasRemoves && (
                <Row><Label>Withdrawn — realized ({agg.removesCount} remove{agg.removesCount === 1 ? '' : 's'})</Label><Value>{fmtUnit(flow.withdrawn, unit, n1, n2)}</Value></Row>
              )}
              <Row><Label>Still in pool — unrealized</Label><Value>{fmtUnit(flow.remaining, unit, n1, n2)}</Value></Row>
              <Row><Label>= Net profit / loss</Label><Value pos={flow.pnl >= 0} neg={flow.pnl < 0}>{fmtUnit(flow.pnl, unit, n1, n2)}</Value></Row>
              <Row sep>
                <Label>Position withdrawn / remaining</Label>
                <Value>{fmtPct(agg.withdrawnFrac, 1).replace('+', '')} / {fmtPct(agg.remainingFrac, 1).replace('+', '')}</Value>
              </Row>
              <PnlSub style={{ marginTop: 8 }}>
                Each add/remove is valued at the pool price <i>at that time</i>; the in-pool remainder at the
                <i> current</i> price — not everything at today&apos;s price.
              </PnlSub>
            </>
          ) : (
            <Message style={{ marginTop: 0 }}>
              This pair has no BEAM-quoted pool, so {unitTabLabel(unit, n1, n2)} valuation isn&apos;t available.
              Switch to {n1} or {n2}.
            </Message>
          )}
        </WideCard>
      </Grid>

      {m ? (
        <Grid>
          {/* REMAINING BASIS */}
          <Card>
            <CardHead><CardTitle>Deposits &amp; remaining basis</CardTitle></CardHead>
            <Row><Label>Operations</Label><Value>{agg.addsCount} add{agg.addsCount === 1 ? '' : 's'}, {agg.removesCount} remove{agg.removesCount === 1 ? '' : 's'}</Value></Row>
            <Row><Label>First add</Label><Value>{new Date(agg.firstAddTs * 1000).toISOString().replace('T', ' ').slice(0, 19)} UTC</Value></Row>
            <Row sep><Label>Total deposited {n1}</Label><Value>{fmtAmount(agg.totalDep1)}<small>{n1}</small></Value></Row>
            <Row><Label>Total deposited {n2}</Label><Value>{fmtAmount(agg.totalDep2)}<small>{n2}</small></Value></Row>
            <Row sep><Label>Remaining basis {n1}</Label><Value>{fmtAmount(m.a1i)}<small>{n1}</small></Value></Row>
            <Row><Label>Remaining basis {n2}</Label><Value>{fmtAmount(m.a2i)}<small>{n2}</small></Value></Row>
            <Row sep><Label>Avg entry price</Label><Value>1 {n2} = {fmtAmount(m.p2in1init)} {n1}</Value></Row>
          </Card>

          {/* CURRENT POOL */}
          <Card>
            <CardHead><CardTitle>Current pool</CardTitle></CardHead>
            <Row><Label>Snapshot height</Label><Value>{pair.snapshot_height ?? '–'}</Value></Row>
            <Row><Label>Fee tier</Label><Value>{pool.kind_label} ({pool.fee_pct}%)</Value></Row>
            <Row><Label>Total {n1}</Label><Value>{fmtAmount(m.a1p)}<small>{n1}</small></Value></Row>
            <Row><Label>Total {n2}</Label><Value>{fmtAmount(m.a2p)}<small>{n2}</small></Value></Row>
            <Row sep><Label>Current price</Label><Value>1 {n2} = {fmtAmount(m.p2in1pool)} {n1}</Value></Row>
          </Card>

          {/* CURRENT POSITION (remaining) */}
          <Card>
            <CardHead><CardTitle>Remaining position</CardTitle></CardHead>
            <Row><Label>Share of the pool</Label><Value>{fmtPct(m.share, 4).replace('+', '')}</Value></Row>
            <Row sep><Label>Principal {n1}</Label><Value>{fmtAmount(m.aid1Principal)}<small>{n1}</small></Value></Row>
            <Row><Label>+ Fees earned {n1}</Label><Value pos={m.aid1Fees >= 0} neg={m.aid1Fees < 0}>{fmtAmount(m.aid1Fees)}<small>{n1}</small></Value></Row>
            <Row><Label>= Available {n1}</Label><Value>{fmtAmount(m.aid1Total)}<small>{n1}</small></Value></Row>
            <Row sep><Label>Principal {n2}</Label><Value>{fmtAmount(m.aid2Principal)}<small>{n2}</small></Value></Row>
            <Row><Label>+ Fees earned {n2}</Label><Value pos={m.aid2Fees >= 0} neg={m.aid2Fees < 0}>{fmtAmount(m.aid2Fees)}<small>{n2}</small></Value></Row>
            <Row><Label>= Available {n2}</Label><Value>{fmtAmount(m.aid2Total)}<small>{n2}</small></Value></Row>
          </Card>

          {/* REMAINING P&L (pair unit, unrealized) */}
          <Card>
            <CardHead>
              <CardTitle>Remaining P&amp;L (unrealized)</CardTitle>
              <SwapBtn onClick={() => setPnlUnit(flip(pnlUnit))}>in {pnlUnit === 1 ? n1 : n2} ⇄</SwapBtn>
            </CardHead>
            {(() => {
              const pnl = computePnl(m, pnlUnit);
              const u = pnlUnit === 1 ? n1 : n2;
              return (
                <>
                  <Row><Label>Time in the pool</Label><Value>{fmtDuration(m.durationMs)}</Value></Row>
                  <Row sep><Label>Current worth</Label><Value>{fmtAmount(pnl.totalCurrent)}<small>{u}</small></Value></Row>
                  <Row><Label>− Basis worth</Label><Value>{fmtAmount(pnl.totalInitial)}<small>{u}</small></Value></Row>
                  <Row><Label>= Profit or Loss</Label><Value pos={pnl.profit >= 0} neg={pnl.profit < 0}>{fmtAmount(pnl.profit)}<small>{u}</small></Value></Row>
                  <Row sep><Label>ROI</Label><Value pos={pnl.roi >= 0} neg={pnl.roi < 0}>{fmtPct(pnl.roi)}</Value></Row>
                  <Row><Label>Estimated APR</Label><Value pos={pnl.apr >= 0} neg={pnl.apr < 0}>{fmtPct(pnl.apr)}</Value></Row>
                  <Row><Label>Price change ({u})</Label><Value pos={pnl.priceChange >= 0} neg={pnl.priceChange < 0}>{fmtPct(pnl.priceChange)}</Value></Row>
                </>
              );
            })()}
          </Card>

          {/* HYPOTHETICALS */}
          <WideCard>
            <CardHead>
              <CardTitle>Hypotheticals (remaining position)</CardTitle>
              <SwapBtn onClick={() => setHypoUnit(flip(hypoUnit))}>in {hypoUnit === 1 ? n1 : n2} ⇄</SwapBtn>
            </CardHead>
            {(() => {
              const hypo = computeHypo(m, hypoUnit);
              const u = hypoUnit === 1 ? n1 : n2;
              return (
                <>
                  <Row><Label>Current worth (in pool)</Label><Value>{fmtAmount(hypo.current)}<small>{u}</small></Value></Row>
                  <Row sep><Label>1. If HODL the pair</Label><Value>{fmtAmount(hypo.hodl)}<small>{u}</small></Value></Row>
                  <Row><Label>P&amp;L vs HODL (impermanent loss)</Label><Value pos={hypo.hodlDiff >= 0} neg={hypo.hodlDiff < 0}>{fmtAmount(hypo.hodlDiff)}<small>{u}</small></Value></Row>
                  <Row sep><Label>2. If HODL all in {n1}</Label><Value>{fmtAmount(hypo.allA1)}<small>{u}</small></Value></Row>
                  <Row><Label>Profit or Loss</Label><Value pos={hypo.allA1Diff >= 0} neg={hypo.allA1Diff < 0}>{fmtAmount(hypo.allA1Diff)}<small>{u}</small></Value></Row>
                  <Row sep><Label>3. If HODL all in {n2}</Label><Value>{fmtAmount(hypo.allA2)}<small>{u}</small></Value></Row>
                  <Row><Label>Profit or Loss</Label><Value pos={hypo.allA2Diff >= 0} neg={hypo.allA2Diff < 0}>{fmtAmount(hypo.allA2Diff)}<small>{u}</small></Value></Row>
                </>
              );
            })()}
          </WideCard>

          {/* ANALYTICS */}
          <WideCard>
            <CardHead>
              <CardTitle>Analytics (remaining position)</CardTitle>
              <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap' }}>
                <Tabs>
                  <Tab active={tab === 'il'} onClick={() => setTab('il')}>IL curve</Tab>
                  <Tab active={tab === 'scenarios'} onClick={() => setTab('scenarios')}>Scenarios</Tab>
                  <Tab active={tab === 'simulator'} onClick={() => setTab('simulator')}>Simulator</Tab>
                </Tabs>
                <SwapBtn style={{ marginLeft: 8 }} onClick={() => setAnalyticsUnit(flip(analyticsUnit))}>in {analyticsUnit === 1 ? n1 : n2} ⇄</SwapBtn>
              </div>
            </CardHead>
            {tab === 'il' && <ILCurveChart metrics={m} unit={analyticsUnit} name1={n1} name2={n2} />}
            {tab === 'scenarios' && <ScenariosChart metrics={m} unit={analyticsUnit} name1={n1} name2={n2} unitName={analyticsUnit === 1 ? n1 : n2} />}
            {tab === 'simulator' && <SimulatorChart metrics={m} unit={analyticsUnit} name1={n1} name2={n2} unitName={analyticsUnit === 1 ? n1 : n2} />}
          </WideCard>
        </Grid>
      ) : (
        <Message>This position is fully withdrawn (nothing remains in the pool), so only the realized P&amp;L above applies.</Message>
      )}
    </>
  );
};

export default LiquidityPosition;
