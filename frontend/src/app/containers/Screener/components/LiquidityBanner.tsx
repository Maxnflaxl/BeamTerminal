import React, { useMemo, useState } from 'react';
import { styled } from '@linaria/react';
import type { ApiPair, LiquidityInterval, LiquiditySource } from '../api/types';
import { usePoolLiquidity, usePagedLpEvents, useAsset } from '../hooks';
import {
  fmt$, fmtNum, fmtPct, fmtPrice, fmtDateFull,
} from './format';
import { PoolHistoryChart, type SeriesVisibility } from './PoolHistoryChart';
import { Pager } from './Pager';

const TIER_FEE_PCT: Record<number, number> = { 0: 0.05, 1: 0.3, 2: 1 };
const LP_PAGE_SIZE = 50;

const TIMEFRAMES: Array<{ label: string; days: number | null; interval: LiquidityInterval }> = [
  { label: 'All', days: null, interval: '1d' },
  { label: '60 days', days: 60, interval: '1d' },
  { label: '30 days', days: 30, interval: '1d' },
  { label: '14 days', days: 14, interval: '1h' },
  { label: '7 days', days: 7, interval: '1h' },
  { label: '3 days', days: 3, interval: '1h' },
  { label: '1 day', days: 1, interval: '1h' },
];

const SOURCES: Array<{ key: LiquiditySource; label: string }> = [
  { key: 'total', label: 'Total' },
  { key: 'lp', label: 'LP providers' },
  { key: 'trades', label: 'Trades' },
];

const Banner = styled.div`
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.02);
  margin-bottom: 12px;
  overflow: hidden;
`;

const Bar = styled.button`
  display: flex;
  align-items: center;
  gap: 28px;
  width: 100%;
  padding: 12px 16px;
  background: none;
  border: none;
  color: inherit;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  flex-wrap: wrap;
  &:hover { background: rgba(255, 255, 255, 0.02); }
  .title { font-size: 17px; font-weight: 700; color: var(--color-green); }
  .stat { display: flex; flex-direction: column; gap: 1px; }
  .stat .k { font-size: 10px; text-transform: uppercase; letter-spacing: 0.4px; color: rgba(255,255,255,0.4); }
  .stat .v { font-family: 'SFProDisplay', monospace; font-size: 14px; color: white; }
  .stat .v .native { color: rgba(255,255,255,0.45); font-size: 12px; margin-left: 4px; }
  .stat .v .pos { color: #00f6d2; margin-left: 6px; }
  .stat .v .neg { color: #f25f5b; margin-left: 6px; }
  .chevron { margin-left: auto; color: rgba(255,255,255,0.4); font-size: 12px; transition: transform 0.15s; }
  .chevron.open { transform: rotate(180deg); }
`;

const Body = styled.div`
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  padding: 14px 16px 8px;
`;

const SectionTitle = styled.div`
  font-size: 14px;
  font-weight: 600;
  color: var(--color-green);
  margin: 10px 0 6px;
`;

const Pooled = styled.div`
  font-size: 13px;
  color: rgba(255, 255, 255, 0.8);
  font-family: 'SFProDisplay', monospace;
  line-height: 1.6;
  .pct { color: rgba(255, 255, 255, 0.4); }
`;

const Controls = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin: 6px 0 4px;
  .group { display: flex; background: rgba(255,255,255,0.04); border-radius: 8px; padding: 2px; }
  button {
    padding: 4px 10px;
    background: transparent;
    border: none;
    border-radius: 6px;
    color: rgba(255, 255, 255, 0.55);
    font-size: 12px;
    font-family: inherit;
    cursor: pointer;
    &:hover { color: white; }
    &.active { background: var(--color-green); color: var(--color-dark-blue); font-weight: 600; }
  }
  .date {
    margin-left: auto;
    background: rgba(255,255,255,0.04);
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 8px;
    color: rgba(255,255,255,0.7);
    padding: 4px 8px;
    font-size: 12px;
    font-family: inherit;
    color-scheme: dark;
  }
`;

const TiersGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
  padding: 8px 0;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  margin-top: 8px;
`;

const TierCard = styled.div`
  font-size: 13px;
  font-family: 'SFProDisplay', monospace;
  color: rgba(255, 255, 255, 0.85);
  line-height: 1.55;
  padding-bottom: 6px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  .type { font-weight: 600; color: white; }
  .lp { color: rgba(255, 255, 255, 0.55); }
  .res { margin-top: 2px; }
`;

const TableWrap = styled.div`
  max-height: 360px;
  overflow-y: auto;
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
      white-space: nowrap;
    }
    td {
      padding: 6px 10px;
      font-size: 12px;
      font-family: 'SFProDisplay', monospace;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      white-space: nowrap;
    }
    .pos { color: #00f6d2; font-weight: 600; }
    .neg { color: #f25f5b; font-weight: 600; }
  }
`;

function human(amount: string | null | undefined, decimals: number): number {
  if (!amount) return 0;
  return Number(amount) / 10 ** decimals;
}

interface Props {
  id: string;
  pair: ApiPair;
}

/** Expandable stats / Liquidity-Pools banner (BeamAssets Image #2). Collapsed it
 *  shows price + 24h volume + market cap + total liquidity; expanded it adds the
 *  pooled totals, the Pool History chart, the fee-tier row, and the paginated
 *  Liquidity-Providers (LP events) table. Scoped to the current pool. */
export const LiquidityBanner: React.FC<Props> = ({ id, pair: p }) => {
  const [open, setOpen] = useState(false);
  const [visible, setVisible] = useState<SeriesVisibility>('both');
  const [tfIndex, setTfIndex] = useState(0);
  const [source, setSource] = useState<LiquiditySource>('total');
  const [centerOn, setCenterOn] = useState<number | null>(null);
  const [lpPage, setLpPage] = useState(0);

  const tf = TIMEFRAMES[tfIndex]!;
  const from = useMemo(
    () => (tf.days === null ? undefined : Math.floor(Date.now() / 1000) - tf.days * 86400),
    [tf.days],
  );

  const sym1 = p.symbol1 ?? `aid${p.aid1}`;
  const sym2 = p.symbol2 ?? `aid${p.aid2}`;
  const isBeamPair = p.aid1 === 0 || p.aid2 === 0;

  // Series + LP events only load once the banner is open.
  const { data: liq } = usePoolLiquidity(open ? id : undefined, { source, interval: tf.interval, from });
  const { items: lpItems, total: lpTotal } = usePagedLpEvents(open ? id : undefined, lpPage, LP_PAGE_SIZE);

  const { data: asset1 } = useAsset(p.aid1);
  const { data: asset2 } = useAsset(p.aid2);
  const supply1 = asset1?.emission ? human(asset1.emission, asset1.decimals) : null;
  const supply2 = asset2?.emission ? human(asset2.emission, asset2.decimals) : null;

  const pct1 = supply1 && supply1 > 0 && p.reserve1_human != null ? (p.reserve1_human / supply1) * 100 : null;
  const pct2 = supply2 && supply2 > 0 && p.reserve2_human != null ? (p.reserve2_human / supply2) * 100 : null;

  // BEAM-per-sym2 (e.g. BEAM per BEAMX) = 1 / (sym2-per-BEAM native price).
  const beamPerToken = p.price_native && p.price_native > 0 ? 1 / p.price_native : null;
  const mcUsd = p.price_usd != null && supply2 != null ? p.price_usd * supply2 : null;
  const mcBeam = beamPerToken != null && supply2 != null ? beamPerToken * supply2 : null;
  const chg = fmtPct(p.price_change_24h);
  const volBeam = isBeamPair ? human(p.volume_24h_groth, p.decimals1) : null;

  const onDate = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const v = e.target.value; // YYYY-MM-DD
    if (!v) { setCenterOn(null); return; }
    const ms = Date.parse(`${v}T00:00:00Z`);
    if (!Number.isNaN(ms)) setCenterOn(Math.floor(ms / 1000));
  };

  return (
    <Banner>
      <Bar type="button" onClick={() => setOpen((v) => !v)}>
        <span className="title">
          {sym1}
          {' / '}
          {sym2}
        </span>
        <span className="stat">
          <span className="k">Price</span>
          <span className="v">
            {fmt$(p.price_usd)}
            {beamPerToken != null && (
              <span className="native">
                {fmtPrice(beamPerToken)}
                {' '}
                {sym1}
              </span>
            )}
            <span className={chg.cls === 'negative' ? 'neg' : 'pos'}>{chg.text}</span>
          </span>
        </span>
        <span className="stat">
          <span className="k">24H Volume</span>
          <span className="v">
            {fmt$(p.volume_24h_usd)}
            {volBeam != null && (
              <span className="native">
                {fmtNum(volBeam, 0)}
                {' '}
                {sym1}
              </span>
            )}
          </span>
        </span>
        {isBeamPair && (
          <span className="stat">
            <span className="k">Market Cap</span>
            <span className="v">
              {fmt$(mcUsd)}
              {mcBeam != null && (
                <span className="native">
                  {fmtNum(mcBeam, 0)}
                  {' '}
                  {sym1}
                </span>
              )}
            </span>
          </span>
        )}
        <span className="stat">
          <span className="k">Total Liquidity</span>
          <span className="v">
            {fmt$(p.tvl_usd)}
            {isBeamPair && p.reserve1_human != null && (
              <span className="native">
                {fmtNum(p.reserve1_human, 0)}
                {' '}
                {sym1}
              </span>
            )}
          </span>
        </span>
        <span className={`chevron ${open ? 'open' : ''}`}>▼</span>
      </Bar>

      {open && (
        <Body>
          <SectionTitle>Liquidity Pools</SectionTitle>
          <Pooled>
            <div>
              {`Total ${sym1} pooled: `}
              {fmtNum(p.reserve1_human, 0)}
              {pct1 != null && (
                <span className="pct">
                  {` (${pct1.toFixed(pct1 < 1 ? 3 : 1)}% of minted supply)`}
                </span>
              )}
            </div>
            <div>
              {`Total ${sym2} pooled: `}
              {fmtNum(p.reserve2_human, 0)}
              {pct2 != null && (
                <span className="pct">
                  {` (${pct2.toFixed(pct2 < 1 ? 3 : 1)}% of minted supply)`}
                </span>
              )}
            </div>
          </Pooled>

          <SectionTitle>Pool History</SectionTitle>
          <Controls>
            <div className="group">
              <button type="button" className={visible === 'both' ? 'active' : ''} onClick={() => setVisible('both')}>Both</button>
              <button type="button" className={visible === '1' ? 'active' : ''} onClick={() => setVisible('1')}>{sym1}</button>
              <button type="button" className={visible === '2' ? 'active' : ''} onClick={() => setVisible('2')}>{sym2}</button>
            </div>
            <div className="group">
              {SOURCES.map((s) => (
                <button key={s.key} type="button" className={source === s.key ? 'active' : ''} onClick={() => setSource(s.key)}>
                  {s.label}
                </button>
              ))}
            </div>
            <div className="group">
              {TIMEFRAMES.map((t, i) => (
                <button key={t.label} type="button" className={i === tfIndex ? 'active' : ''} onClick={() => setTfIndex(i)}>
                  {t.label}
                </button>
              ))}
            </div>
            <input className="date" type="date" onChange={onDate} title="Center on date" />
          </Controls>
          <PoolHistoryChart
            series={liq?.series ?? []}
            decimals1={liq?.decimals1 ?? p.decimals1}
            decimals2={liq?.decimals2 ?? p.decimals2}
            sym1={sym1}
            sym2={sym2}
            visible={visible}
            centerOn={centerOn}
          />

          <TiersGrid>
            {(p.tiers ?? [{
              pool_id: p.pair_id,
              kind: p.kind,
              kind_label: p.kind_label,
              lp_token: p.lp_token,
              tvl_usd: p.tvl_usd,
              volume_24h_usd: p.volume_24h_usd,
              reserve1_human: p.reserve1_human,
              reserve2_human: p.reserve2_human,
              price_native: p.price_native,
            }]).map((t) => (
              <TierCard key={t.kind}>
                <div className="type">
                  Pool type:
                  {' '}
                  {(TIER_FEE_PCT[t.kind] ?? 0).toFixed(2)}
                  % fees
                </div>
                <div className="lp">
                  LP asset ID:
                  {' '}
                  {t.lp_token}
                </div>
                <div className="res">
                  {fmtNum(t.reserve1_human, 2)}
                  {' '}
                  {sym1}
                </div>
                <div className="res">
                  {fmtNum(t.reserve2_human, 2)}
                  {' '}
                  {sym2}
                </div>
              </TierCard>
            ))}
          </TiersGrid>

          <SectionTitle>Liquidity Providers</SectionTitle>
          <TableWrap>
            <table>
              <thead>
                <tr>
                  <th>Time (UTC)</th>
                  <th>Liquidity</th>
                  <th>{`Amount ${sym1}`}</th>
                  <th>{`Amount ${sym2}`}</th>
                  <th>Change</th>
                </tr>
              </thead>
              <tbody>
                {lpItems.map((e) => {
                  const dep = e.kind === 'Deposit';
                  const pct = e.liquidity_pct ?? null;
                  return (
                    <tr key={e.event_id}>
                      <td>{fmtDateFull(e.timestamp)}</td>
                      <td className={dep ? 'pos' : 'neg'}>{dep ? 'deposit' : 'withdraw'}</td>
                      <td className={dep ? 'pos' : 'neg'}>{fmtNum(human(e.amount1, p.decimals1), 4)}</td>
                      <td className={dep ? 'pos' : 'neg'}>{fmtNum(human(e.amount2, p.decimals2), 4)}</td>
                      <td className={pct != null && pct < 0 ? 'neg' : 'pos'}>
                        {pct != null ? `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%` : '—'}
                      </td>
                    </tr>
                  );
                })}
                {lpItems.length === 0 && (
                  <tr>
                    <td colSpan={5} style={{ textAlign: 'center', padding: '24px 8px', color: 'rgba(255,255,255,0.4)' }}>
                      No liquidity events yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </TableWrap>
          <Pager
            page={lpPage}
            pageSize={LP_PAGE_SIZE}
            total={lpTotal}
            loadedCount={lpItems.length}
            onChange={setLpPage}
          />
        </Body>
      )}
    </Banner>
  );
};
