import React, { useEffect, useState } from 'react';
import { styled } from '@linaria/react';
import { Page, ExplorerHeader, H1, Subtitle, StatGrid, StatCard, Label, Value, DataTable, ScrollX, Pill, ErrorBox, theme } from '../shared';
import { api } from '../../../api/client';
import type { ApiDaoRevenue } from '../../../api/types';
import { TimeChart, fmtUsd } from './daoShared';

const TIER_LABEL = ['0.05%', '0.30%', '1.00%'];
const tierTone = (tier: number): 'accent' | 'warn' | 'danger' => (tier === 0 ? 'accent' : tier === 1 ? 'warn' : 'danger');

const Panel = styled.div`
  background: ${theme.color.surface};
  border: 1px solid ${theme.color.borderDim};
  border-radius: ${theme.radius.lg};
  margin-bottom: 20px;
  overflow: hidden;
`;
const PanelHead = styled.div`
  padding: 12px 16px;
  border-bottom: 1px solid ${theme.color.borderDim};
  font-size: 12px;
  color: ${theme.color.muted};
  text-transform: uppercase;
  letter-spacing: 0.05em;
`;
const PanelBody = styled.div` padding: 14px 16px; `;
const HBar = styled.div`
  display: flex;
  align-items: center;
  margin: 6px 0;
  font-size: 12px;
  & .lbl { width: 80px; color: ${theme.color.text}; }
  & .track { flex: 1; height: 10px; background: ${theme.color.surface2}; border-radius: 4px; overflow: hidden; margin: 0 10px; }
  & .fill { height: 100%; background: ${theme.color.accent}; }
  & .val { width: 90px; text-align: right; color: ${theme.color.muted}; }
`;

export const DaoRevenue: React.FC = () => {
  const [d, setD] = useState<ApiDaoRevenue | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = (): void => {
      api
        .daoRevenue('source')
        .then((x) => {
          if (alive) {
            setD(x);
            setError(null);
          }
        })
        .catch((e: unknown) => {
          if (alive) setError(e instanceof Error ? e.message : String(e));
        });
    };
    load();
    const id = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const dailySeries = (d?.series ?? []).map((s) => ({ label: s.day, value: Object.values(s.by_asset).reduce((a, b) => a + b, 0) }));
  const d30 = dailySeries.slice(-30).reduce((a, b) => a + b.value, 0);

  return (
    <Page>
      <ExplorerHeader>
        <div>
          <H1>Revenue</H1>
          <Subtitle>Protocol fees skimmed into the DAO</Subtitle>
        </div>
      </ExplorerHeader>

      {error && <ErrorBox>Failed to load revenue: {error}</ErrorBox>}

      <StatGrid>
        <StatCard>
          <Label>All-time</Label>
          <Value style={{ color: theme.color.accent }}>{fmtUsd(d?.total_usd ?? null)}</Value>
        </StatCard>
        <StatCard>
          <Label>Last 30 days</Label>
          <Value>{fmtUsd(d ? d30 : null)}</Value>
        </StatCard>
        <StatCard>
          <Label>Top source</Label>
          <Value>{d?.by_source[0]?.source ?? '—'}</Value>
        </StatCard>
      </StatGrid>

      <Panel>
        <PanelHead>Revenue over time (USD/day)</PanelHead>
        <div style={{ padding: '14px 16px' }}>
          <TimeChart data={dailySeries} fmtY={fmtUsd} />
        </div>
      </Panel>

      <Panel>
        <PanelHead>By source</PanelHead>
        <PanelBody>
          {(d?.by_source ?? []).map((s) => (
            <HBar key={s.source}>
              <span className="lbl">{s.source}</span>
              <span className="track">
                <span className="fill" style={{ width: `${Math.max(1, s.pct)}%` }} />
              </span>
              <span className="val">
                {s.pct.toFixed(0)}% · {fmtUsd(s.usd)}
              </span>
            </HBar>
          ))}
          {(d?.by_source.length ?? 0) === 0 && <div style={{ color: theme.color.muted, fontSize: 12 }}>No data.</div>}
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHead>Top pools by fees · DEX</PanelHead>
        <ScrollX>
          <DataTable>
            <thead>
              <tr>
                <th>Pair</th>
                <th>Tier</th>
                <th className="right">Fees</th>
              </tr>
            </thead>
            <tbody>
              {(d?.top_pools ?? []).map((p) => (
                <tr key={p.pool_id}>
                  <td>{p.pair}</td>
                  <td>
                    <Pill data-tone={tierTone(p.tier)}>{TIER_LABEL[p.tier] ?? `t${p.tier}`}</Pill>
                  </td>
                  <td className="right">{fmtUsd(p.usd)}</td>
                </tr>
              ))}
              {(d?.top_pools.length ?? 0) === 0 && (
                <tr>
                  <td colSpan={3} style={{ textAlign: 'center', padding: 22, color: theme.color.muted }}>
                    No pool fees loaded.
                  </td>
                </tr>
              )}
            </tbody>
          </DataTable>
        </ScrollX>
      </Panel>
    </Page>
  );
};

export default DaoRevenue;
