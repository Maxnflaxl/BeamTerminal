import React, { useCallback, useEffect, useState } from 'react';
import { styled } from '@linaria/react';
import {
  Page, Card, ExplorerHeader, H1, H2, Subtitle, Muted, TabBtn,
  Pill, DataTable, ScrollX, ErrorBox, Row, theme,
} from './shared';
import { api } from '../../api/client';
import type {
  ApiAtomicSwapOffer,
  ApiAtomicSwapTotalsPoint,
} from '../../api/types';

// ---------------------------------------------------------------------------
// /atomic-swaps — cross-chain BEAM ↔ BTC/LTC/QTUM/DOGE/DASH/ETH/DAI/USDT/WBTC
// Source: backend `/api/atomic-swaps` + `/atomic-swaps/totals`.
// ---------------------------------------------------------------------------

const REFRESH_MS = 30_000;

type FilterTab = 'open' | 'all';

const Toolbar = styled.div`
  display: flex;
  & > * + * { margin-left: 6px; }
  flex-wrap: wrap;
  margin: 8px 0 12px;
`;

const StatsRow = styled.div`
  display: flex;
  & > * + * { margin-left: 14px; }
  flex-wrap: wrap;
  margin-bottom: 18px;
`;

const StatBox = styled.div`
  flex: 1 1 160px;
  background: ${theme.color.surface2};
  border: 1px solid ${theme.color.borderDim};
  border-radius: ${theme.radius.md};
  padding: 10px 12px;
  min-width: 140px;
`;

const StatLabel = styled.div`
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: ${theme.color.muted};
`;

const StatValue = styled.div`
  font-family: monospace;
  margin-top: 4px;
`;

function fmtBigDec(v: string | null | undefined): string {
  if (v === null || v === undefined) return '—';
  // Most counter-currencies report integer "atoms" (satoshi-equivalent) just like
  // BEAM groths. Without per-currency unit info we render the raw value with
  // thousands separators rather than guess decimals.
  const n = Number(v);
  if (Number.isFinite(n) && Math.abs(n) < 1e15) {
    return new Intl.NumberFormat().format(n);
  }
  return v;
}

function fmtRelative(iso: string): string {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return '—';
  const delta = Math.round((Date.now() - ts) / 1000);
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.round(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.round(delta / 3600)}h ago`;
  return `${Math.round(delta / 86400)}d ago`;
}

const OFFERED_KEYS: Array<keyof ApiAtomicSwapTotalsPoint['offered']> = [
  'BEAM', 'BTC', 'LTC', 'QTUM', 'DOGE', 'DASH', 'ETH', 'DAI', 'USDT', 'WBTC',
];

export const AtomicSwaps: React.FC = () => {
  const [tab, setTab] = useState<FilterTab>('open');
  const [offers, setOffers] = useState<ApiAtomicSwapOffer[] | null>(null);
  const [totals, setTotals] = useState<ApiAtomicSwapTotalsPoint | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [a, t] = await Promise.all([
        api.atomicSwaps(tab === 'all' ? { include: 'all' } : {}),
        api.atomicSwapTotals(),
      ]);
      setOffers(a.offers);
      setTotals(t.latest);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [tab]);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => { void refresh(); }, REFRESH_MS);
    return () => clearInterval(id);
  }, [refresh]);

  return (
    <Page>
      <ExplorerHeader>
        <div>
          <H1>Atomic swaps</H1>
          <Subtitle>Cross-chain BEAM ↔ BTC/LTC/QTUM/DOGE/DASH/ETH/DAI/USDT/WBTC offers.</Subtitle>
        </div>
      </ExplorerHeader>

      <Card>
        <H2>Currently offered</H2>
        {totals ? (
          <StatsRow>
            <StatBox>
              <StatLabel>Open offers</StatLabel>
              <StatValue>{totals.total_swaps_count ?? '—'}</StatValue>
            </StatBox>
            {OFFERED_KEYS.map((k) => (
              <StatBox key={k}>
                <StatLabel>{k} offered</StatLabel>
                <StatValue>{fmtBigDec(totals.offered[k])}</StatValue>
              </StatBox>
            ))}
          </StatsRow>
        ) : <Muted>No totals snapshot yet — the indexer captures one per tick.</Muted>}
      </Card>

      <Card>
        <H2>Offers</H2>
        <Toolbar>
          <TabBtn type="button" data-active={tab === 'open'}  onClick={() => setTab('open')}>Open</TabBtn>
          <TabBtn type="button" data-active={tab === 'all'}   onClick={() => setTab('all')}>All (incl. closed)</TabBtn>
        </Toolbar>
        {err ? <ErrorBox>{err}</ErrorBox> : null}
        {offers === null ? <Muted>Loading…</Muted>
          : offers.length === 0 ? <Muted>No offers.</Muted>
            : (
              <ScrollX>
                <DataTable>
                  <thead>
                    <tr>
                      <th>Side</th>
                      <th>Status</th>
                      <th>BEAM amount</th>
                      <th>Counter</th>
                      <th>Counter amount</th>
                      <th>Created</th>
                      <th>Expires (height)</th>
                      <th>Last seen</th>
                      <th>State</th>
                    </tr>
                  </thead>
                  <tbody>
                    {offers.map((o) => (
                      <tr key={`${o.tx_id}-${o.is_beam_side}`}>
                        <td>
                          <Pill data-tone={o.is_beam_side ? 'info' : 'success'}>
                            {o.is_beam_side ? 'BEAM-side' : 'Counter-side'}
                          </Pill>
                        </td>
                        <td>{o.status_string ?? `#${o.status}`}</td>
                        <td className="mono">{fmtBigDec(o.beam_amount)}</td>
                        <td>{o.swap_currency_name ?? `#${o.swap_currency}`}</td>
                        <td className="mono">{fmtBigDec(o.swap_amount)}</td>
                        <td>{fmtRelative(o.time_created)}</td>
                        <td className="mono">{o.height_expired ?? '—'}</td>
                        <td>{fmtRelative(o.last_seen_at)}</td>
                        <td>{o.gone_at ? <Pill data-tone="danger">closed</Pill> : <Pill data-tone="success">open</Pill>}</td>
                      </tr>
                    ))}
                  </tbody>
                </DataTable>
              </ScrollX>
            )}
        <Row>
          <Muted>Updates every {REFRESH_MS / 1000}s.</Muted>
        </Row>
      </Card>
    </Page>
  );
};

export default AtomicSwaps;
