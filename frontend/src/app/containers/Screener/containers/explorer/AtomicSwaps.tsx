import React, { useCallback, useEffect, useState } from 'react';
import AtomicSwapGlyph from '@app/shared/icons/icon-atomic-swap.svg';
import {
  Page,
  Card,
  ExplorerHeader,
  H1,
  H2,
  Subtitle,
  Muted,
  TabBtn,
  Pill,
  DataTable,
  ScrollX,
  ErrorBox,
  Toolbar,
  SummaryStrip,
  Headline,
  StatLabel,
  HeadNum,
  Chips,
  Chip,
  EmptyState,
  EmptyIcon,
  EmptyTitle,
  EmptySub,
  fmtRelative,
} from './shared';
import { api } from '../../api/client';
import type { ApiAtomicSwapOffer, ApiAtomicSwapTotalsPoint } from '../../api/types';

// ---------------------------------------------------------------------------
// /atomic-swaps — cross-chain BEAM ↔ BTC/LTC/QTUM/DOGE/DASH/ETH/DAI/USDT/WBTC
// Source: backend `/api/atomic-swaps` + `/atomic-swaps/totals`.
// ---------------------------------------------------------------------------

type FilterTab = 'open' | 'all';

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

const OFFERED_KEYS: Array<keyof ApiAtomicSwapTotalsPoint['offered']> = [
  'BEAM',
  'BTC',
  'LTC',
  'QTUM',
  'DOGE',
  'DASH',
  'ETH',
  'DAI',
  'USDT',
  'WBTC',
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
  }, [refresh]);

  return (
    <Page>
      <ExplorerHeader>
        <div>
          <H1>Atomic swaps</H1>
          <Subtitle>Cross-chain BEAM ↔ BTC/LTC/QTUM/DOGE/DASH/ETH/DAI/USDT/WBTC offers.</Subtitle>
        </div>
      </ExplorerHeader>

      {totals ? (
        <SummaryStrip>
          <Headline>
            <StatLabel>Open offers</StatLabel>
            <HeadNum>{totals.total_swaps_count ?? 0}</HeadNum>
          </Headline>
          {((totals.total_swaps_count ?? 0) > 0 || OFFERED_KEYS.some((k) => Number(totals.offered[k] ?? 0) > 0)) && (
            <Chips>
              {OFFERED_KEYS.map((k) => {
                const hot = Number(totals.offered[k] ?? 0) > 0;
                return (
                  <Chip key={k} hot={hot}>
                    <span>{k}</span>
                    <span className="v">{fmtBigDec(totals.offered[k])}</span>
                  </Chip>
                );
              })}
            </Chips>
          )}
        </SummaryStrip>
      ) : (
        <Card>
          <Muted>No totals snapshot yet — the indexer captures one per tick.</Muted>
        </Card>
      )}

      <Card>
        <H2>Offers</H2>
        <Toolbar>
          <TabBtn type="button" data-active={tab === 'open'} onClick={() => setTab('open')}>
            Open
          </TabBtn>
          <TabBtn type="button" data-active={tab === 'all'} onClick={() => setTab('all')}>
            All (incl. closed)
          </TabBtn>
        </Toolbar>
        {err ? <ErrorBox>{err}</ErrorBox> : null}
        {offers === null ? (
          <Muted>Loading…</Muted>
        ) : offers.length === 0 ? (
          <EmptyState>
            <EmptyIcon>
              <AtomicSwapGlyph />
            </EmptyIcon>
            <EmptyTitle>{tab === 'open' ? 'No open swap offers right now' : 'No swap offers found'}</EmptyTitle>
            <EmptySub>Cross-chain BEAM ↔ BTC/ETH/USDT… offers created in the BEAM wallet appear here.</EmptySub>
          </EmptyState>
        ) : (
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
                    <td>
                      {o.gone_at ? <Pill data-tone="danger">closed</Pill> : <Pill data-tone="success">open</Pill>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          </ScrollX>
        )}
      </Card>
    </Page>
  );
};

export default AtomicSwaps;
