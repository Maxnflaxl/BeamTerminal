import React, { useEffect, useState } from 'react';
import { styled } from '@linaria/react';
import { Page, ExplorerHeader, H1, Subtitle, StatGrid, StatCard, Label, Value, DataTable, ScrollX, Btn, ErrorBox, theme } from '../shared';
import { api } from '../../../api/client';
import type { ApiDaoTreasury } from '../../../api/types';
import { Sparkline, fmtUsd, fmtCompact, grothToBeamx } from './daoShared';

const PALETTE = [theme.color.accent, theme.color.purple, theme.color.info, theme.color.warn, theme.color.danger, '#7a8cff', '#5ad1b0', '#c0a0ff'];

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
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
  color: ${theme.color.muted};
  text-transform: uppercase;
  letter-spacing: 0.05em;
`;
const FlowRow = styled.div`
  display: grid;
  grid-template-columns: 120px 110px 1fr;
  gap: 12px;
  padding: 9px 16px;
  border-bottom: 1px solid ${theme.color.borderDim};
  font-size: 12px;
  &:last-child { border-bottom: 0; }
`;
const Overlay = styled.div`
  position: fixed;
  inset: 0;
  background: rgba(2, 12, 24, 0.8);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
`;
const Modal = styled.div`
  width: 90%;
  max-width: 460px;
  background: ${theme.color.surface};
  border: 1px solid ${theme.color.border};
  border-radius: ${theme.radius.lg};
  overflow: hidden;
`;
const ModalHead = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid ${theme.color.borderDim};
  font-weight: 700;
  color: ${theme.color.text};
`;
const Closer = styled.button`
  background: none;
  border: 0;
  color: ${theme.color.muted};
  font-size: 18px;
  cursor: pointer;
`;
const DonutBody = styled.div`
  display: flex;
  gap: 18px;
  align-items: center;
  padding: 18px;
  flex-wrap: wrap;
`;
const Donut = styled.div`
  width: 130px;
  height: 130px;
  border-radius: 50%;
  flex-shrink: 0;
  position: relative;
  &::after {
    content: '';
    position: absolute;
    inset: 34px;
    border-radius: 50%;
    background: ${theme.color.surface};
  }
`;
const Center = styled.div`
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  & b { color: ${theme.color.text}; font-size: 15px; }
  & span { color: ${theme.color.muted}; font-size: 10px; text-transform: uppercase; }
`;
const DLegend = styled.div`
  flex: 1;
  min-width: 160px;
  font-size: 12px;
`;
const DLegendRow = styled.div`
  display: flex;
  justify-content: space-between;
  padding: 3px 0;
  border-bottom: 1px solid ${theme.color.borderDim};
  & i { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 6px; }
`;

export const DaoTreasury: React.FC = () => {
  const [d, setD] = useState<ApiDaoTreasury | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [donut, setDonut] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = (): void => {
      api
        .daoTreasury()
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

  const holdings = d?.holdings ?? [];
  const priced = holdings.filter((h) => h.value_usd != null);
  // conic-gradient stops from cumulative pct
  let acc = 0;
  const stops = priced
    .map((h, i) => {
      const from = acc;
      acc += h.pct;
      return `${PALETTE[i % PALETTE.length]} ${from}% ${acc}%`;
    })
    .join(', ');

  return (
    <Page>
      <ExplorerHeader>
        <div>
          <H1>Treasury</H1>
          <Subtitle>DAO Vault · Holdings &amp; value</Subtitle>
        </div>
      </ExplorerHeader>

      {error && <ErrorBox>Failed to load treasury: {error}</ErrorBox>}

      <StatGrid>
        <StatCard>
          <Label>Total value</Label>
          <Value style={{ color: theme.color.accent }}>{fmtUsd(d?.total_usd ?? null)}</Value>
        </StatCard>
        <StatCard>
          <Label>Assets held</Label>
          <Value>{holdings.length}</Value>
        </StatCard>
        <StatCard>
          <Label>Largest holding</Label>
          <Value>{holdings[0]?.symbol ?? '—'}</Value>
        </StatCard>
      </StatGrid>

      <Panel>
        <PanelHead>Treasury value over time</PanelHead>
        <div style={{ padding: '14px 16px' }}>
          <Sparkline data={(d?.value_series ?? []).map((s) => s.usd)} />
        </div>
      </Panel>

      <Panel>
        <PanelHead>
          <span>Holdings</span>
          {priced.length > 0 && (
            <Btn type="button" data-variant="ghost" onClick={() => setDonut(true)}>
              ◔ Chart
            </Btn>
          )}
        </PanelHead>
        <ScrollX>
          <DataTable>
            <thead>
              <tr>
                <th>Asset</th>
                <th className="right">Value</th>
                <th className="right">%</th>
              </tr>
            </thead>
            <tbody>
              {holdings.map((h) => (
                <tr key={h.aid}>
                  <td style={{ color: theme.color.accent }}>{h.symbol}</td>
                  <td className="right">{h.value_usd != null ? fmtUsd(h.value_usd) : '—'}</td>
                  <td className="right">{h.pct.toFixed(1)}%</td>
                </tr>
              ))}
              {holdings.length === 0 && (
                <tr>
                  <td colSpan={3} style={{ textAlign: 'center', padding: 22, color: theme.color.muted }}>
                    No holdings loaded.
                  </td>
                </tr>
              )}
            </tbody>
          </DataTable>
        </ScrollX>
      </Panel>

      <Panel>
        <PanelHead>Vault flows · deposits &amp; withdrawals</PanelHead>
        <div>
          {(d?.flows ?? []).map((f, i) => {
            const entries = Object.entries(f.funds);
            return (
              <FlowRow key={`${f.height}-${i}`}>
                <span style={{ color: theme.color.muted }}>h {f.height}</span>
                <span>{f.method}</span>
                <span>
                  {entries.map(([aid, amt]) => {
                    const n = Number(amt);
                    return (
                      <span key={aid} style={{ color: n >= 0 ? theme.color.accent : theme.color.danger, marginRight: 10 }}>
                        {n >= 0 ? '+' : '−'}
                        {fmtCompact(Math.abs(grothToBeamx(amt)))} aid:{aid}
                      </span>
                    );
                  })}
                </span>
              </FlowRow>
            );
          })}
          {(d?.flows.length ?? 0) === 0 && (
            <div style={{ textAlign: 'center', padding: 22, color: theme.color.muted, fontSize: 12 }}>No recent flows.</div>
          )}
        </div>
      </Panel>

      {donut && (
        <Overlay onClick={() => setDonut(false)}>
          <Modal onClick={(e) => e.stopPropagation()}>
            <ModalHead>
              <span>Holdings composition</span>
              <Closer type="button" onClick={() => setDonut(false)}>
                ✕
              </Closer>
            </ModalHead>
            <DonutBody>
              <Donut style={{ background: `conic-gradient(${stops || `${theme.color.surface2} 0% 100%`})` }}>
                <Center>
                  <b>{fmtUsd(d?.total_usd ?? null)}</b>
                  <span>total</span>
                </Center>
              </Donut>
              <DLegend>
                {priced.map((h, i) => (
                  <DLegendRow key={h.aid}>
                    <span>
                      <i style={{ background: PALETTE[i % PALETTE.length] }} />
                      {h.symbol}
                    </span>
                    <span>
                      {h.pct.toFixed(1)}% · {fmtUsd(h.value_usd)}
                    </span>
                  </DLegendRow>
                ))}
              </DLegend>
            </DonutBody>
          </Modal>
        </Overlay>
      )}
    </Page>
  );
};

export default DaoTreasury;
