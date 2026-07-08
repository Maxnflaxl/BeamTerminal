import React, { useEffect, useState } from 'react';
import { styled } from '@linaria/react';
import { Page, ExplorerHeader, H1, Subtitle, StatGrid, StatCard, Label, Value, DataTable, ScrollX, Btn, ErrorBox, theme } from '../shared';
import AssetIcon from '@app/shared/components/AssetsIcon';
import { PALLETE_ASSETS } from '@app/shared/constants';
import { fromGrothsStr } from '../../../components/format';
import { api } from '../../../api/client';
import type { ApiDaoTreasury, ApiDaoAssetHistory, ApiAssetListEntry } from '../../../api/types';
import { TimeChart, fmtUsd, fmtCompact } from './daoShared';

const PALETTE = PALLETE_ASSETS;

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
const AssetCell = styled.div`
  display: flex;
  align-items: center;
  & b { color: ${theme.color.text}; font-weight: 600; }
  & small { color: ${theme.color.muted}; margin-left: 8px; font-size: 11px; }
`;
const ClickRow = styled.tr`
  cursor: pointer;
  &:hover { background: ${theme.color.rowHover}; }
`;
const FlowRow = styled.div`
  display: grid;
  grid-template-columns: 96px 96px 1fr;
  gap: 12px;
  padding: 9px 16px;
  border-bottom: 1px solid ${theme.color.borderDim};
  font-size: 12px;
  align-items: center;
  &:last-child { border-bottom: 0; }
`;
const FundTag = styled.span`
  display: inline-flex;
  align-items: center;
  margin-right: 12px;
  font-variant-numeric: tabular-nums;
`;
const Overlay = styled.div`
  position: fixed;
  top: 0; right: 0; bottom: 0; left: 0;
  background: rgba(2, 12, 24, 0.8);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
`;
const Modal = styled.div`
  width: 90%;
  max-width: 480px;
  max-height: 84vh;
  display: flex;
  flex-direction: column;
  background: ${theme.color.bg};
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
  gap: 20px;
  align-items: center;
  padding: 20px;
  flex-wrap: wrap;
`;
const DLegend = styled.div`
  flex: 1;
  min-width: 190px;
  font-size: 12px;
`;
const DLegendRow = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 4px 0;
  border-bottom: 1px solid ${theme.color.borderDim};
  cursor: pointer;
  &:hover { color: ${theme.color.accent}; }
  & .l { display: flex; align-items: center; }
  & .r { color: ${theme.color.muted}; font-variant-numeric: tabular-nums; }
`;
const HistSummary = styled.div`
  padding: 12px 16px;
  border-bottom: 1px solid ${theme.color.borderDim};
  font-size: 12px;
  display: flex;
  gap: 18px;
`;

export const DaoTreasury: React.FC = () => {
  const [d, setD] = useState<ApiDaoTreasury | null>(null);
  const [meta, setMeta] = useState<Map<number, ApiAssetListEntry>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [donut, setDonut] = useState(false);
  const [hist, setHist] = useState<{ aid: number; data: ApiDaoAssetHistory | null } | null>(null);

  useEffect(() => {
    let alive = true;
    const load = (): void => {
      api
        .daoTreasury()
        .then((x) => alive && (setD(x), setError(null)))
        .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)));
    };
    load();
    api
      .assets()
      .then((x) => alive && setMeta(new Map(x.assets.map((a) => [a.aid, a]))))
      .catch(() => {});
    const id = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const symOf = (aid: number): string => meta.get(aid)?.short_name ?? `aid ${aid}`;
  const nameOf = (aid: number): string | null => meta.get(aid)?.name ?? null;
  const colorOf = (aid: number, i: number): string => {
    const c = meta.get(aid)?.color;
    return c ? (c.startsWith('#') ? c : `#${c}`) : PALETTE[i % PALETTE.length];
  };
  const fmtAmt = (groth: string, aid: number): string => {
    const dec = meta.get(aid)?.decimals ?? 8;
    return fmtCompact(Number(groth) / Math.pow(10, dec));
  };

  const openAsset = (aid: number): void => {
    setHist({ aid, data: null });
    api
      .daoTreasuryAsset(aid)
      .then((data) => setHist((cur) => (cur && cur.aid === aid ? { aid, data } : cur)))
      .catch(() => {});
  };

  const holdings = d?.holdings ?? [];
  const priced = holdings.filter((h) => h.value_usd != null);
  const DONUT_R = 58;
  const CIRC = 2 * Math.PI * DONUT_R;
  let donutOff = 0;
  const donutSegs = priced.map((h, i) => {
    const dash = (h.pct / 100) * CIRC;
    const seg = { aid: h.aid, color: colorOf(h.aid, i), dash, off: donutOff };
    donutOff += dash;
    return seg;
  });

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
          <Value>{holdings[0] ? symOf(holdings[0].aid) : '—'}</Value>
        </StatCard>
      </StatGrid>

      <Panel>
        <PanelHead>Treasury value over time (USD)</PanelHead>
        <div style={{ padding: '14px 16px' }}>
          <TimeChart data={(d?.value_series ?? []).map((s) => ({ label: s.day, value: s.usd }))} fmtY={fmtUsd} />
        </div>
      </Panel>

      <Panel>
        <PanelHead>
          <span>Holdings · click an asset for its deposit history</span>
          {priced.length > 0 && (
            <Btn type="button" data-variant="ghost" onClick={() => setDonut(true)}>
              ◑ Donut
            </Btn>
          )}
        </PanelHead>
        <ScrollX>
          <DataTable>
            <thead>
              <tr>
                <th>Asset</th>
                <th className="right">Amount</th>
                <th className="right">Value</th>
                <th className="right">%</th>
              </tr>
            </thead>
            <tbody>
              {holdings.map((h) => (
                <ClickRow key={h.aid} onClick={() => openAsset(h.aid)}>
                  <td>
                    <AssetCell>
                      <AssetIcon asset_id={h.aid} color={meta.get(h.aid)?.color} size={20} />
                      <b>{symOf(h.aid)}</b>
                      {nameOf(h.aid) && <small>{nameOf(h.aid)}</small>}
                    </AssetCell>
                  </td>
                  <td className="right">{fmtAmt(h.amount, h.aid)}</td>
                  <td className="right">{h.value_usd != null ? fmtUsd(h.value_usd) : '—'}</td>
                  <td className="right">{h.pct.toFixed(2)}%</td>
                </ClickRow>
              ))}
              {holdings.length === 0 && (
                <tr>
                  <td colSpan={4} style={{ textAlign: 'center', padding: 22, color: theme.color.muted }}>
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
          {(d?.flows ?? []).map((f, i) => (
            <FlowRow key={`${f.height}-${i}`}>
              <span style={{ color: theme.color.muted }}>h {f.height}</span>
              <span>{f.method}</span>
              <span>
                {Object.entries(f.funds).map(([aid, amt]) => {
                  const n = Number(amt);
                  const id = Number(aid);
                  return (
                    <FundTag key={aid} style={{ color: n >= 0 ? theme.color.accent : theme.color.danger }}>
                      <AssetIcon asset_id={id} color={meta.get(id)?.color} size={14} />
                      {n >= 0 ? '+' : '−'}
                      {fmtAmt(String(Math.abs(n)), id)} {symOf(id)}
                    </FundTag>
                  );
                })}
              </span>
            </FlowRow>
          ))}
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
              <svg viewBox="0 0 150 150" width="150" height="150" style={{ flexShrink: 0 }}>
                <g transform="rotate(-90 75 75)">
                  {donutSegs.length === 0 ? (
                    <circle cx="75" cy="75" r={DONUT_R} fill="none" stroke={theme.color.surface2} strokeWidth="26" />
                  ) : (
                    donutSegs.map((s) => (
                      <circle
                        key={s.aid}
                        cx="75"
                        cy="75"
                        r={DONUT_R}
                        fill="none"
                        stroke={s.color}
                        strokeWidth="26"
                        strokeDasharray={`${s.dash.toFixed(2)} ${(CIRC - s.dash).toFixed(2)}`}
                        strokeDashoffset={(-s.off).toFixed(2)}
                      />
                    ))
                  )}
                </g>
                <text x="75" y="72" textAnchor="middle" fontSize="15" fontWeight="700" fill={theme.color.text}>
                  {fmtUsd(d?.total_usd ?? null)}
                </text>
                <text x="75" y="87" textAnchor="middle" fontSize="8" fill={theme.color.muted}>
                  TOTAL
                </text>
              </svg>
              <DLegend>
                {priced.map((h) => (
                  <DLegendRow key={h.aid} onClick={() => (setDonut(false), openAsset(h.aid))}>
                    <span className="l">
                      <AssetIcon asset_id={h.aid} color={meta.get(h.aid)?.color} size={16} />
                      {symOf(h.aid)}
                    </span>
                    <span className="r">
                      {h.pct.toFixed(2)}% · {fmtAmt(h.amount, h.aid)} · {fmtUsd(h.value_usd)}
                    </span>
                  </DLegendRow>
                ))}
              </DLegend>
            </DonutBody>
          </Modal>
        </Overlay>
      )}

      {hist && (
        <Overlay onClick={() => setHist(null)}>
          <Modal onClick={(e) => e.stopPropagation()}>
            <ModalHead>
              <span style={{ display: 'flex', alignItems: 'center' }}>
                <AssetIcon asset_id={hist.aid} color={meta.get(hist.aid)?.color} size={18} />
                {symOf(hist.aid)} · deposit history
              </span>
              <Closer type="button" onClick={() => setHist(null)}>
                ✕
              </Closer>
            </ModalHead>
            {!hist.data ? (
              <div style={{ padding: 22, color: theme.color.muted, fontSize: 12 }}>Loading…</div>
            ) : (
              <>
                <HistSummary>
                  <span style={{ color: theme.color.accent }}>
                    Deposits +{fmtAmt(hist.data.deposits_groth, hist.aid)}
                  </span>
                  <span style={{ color: theme.color.danger }}>
                    Withdrawals {fmtAmt(hist.data.withdrawals_groth, hist.aid)}
                  </span>
                </HistSummary>
                <ScrollX style={{ overflowY: 'auto' }}>
                  <DataTable>
                    <thead>
                      <tr>
                        <th>Height</th>
                        <th>Via</th>
                        <th className="right">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {hist.data.rows.map((r, i) => {
                        const n = Number(r.amount);
                        return (
                          <tr key={`${r.height}-${i}`}>
                            <td style={{ color: theme.color.muted }}>{r.height}</td>
                            <td>{r.method}</td>
                            <td className="right" style={{ color: n >= 0 ? theme.color.accent : theme.color.danger, fontVariantNumeric: 'tabular-nums' }}>
                              {n >= 0 ? '+' : ''}
                              {fromGrothsStr(r.amount, meta.get(hist.aid)?.decimals ?? 8)}
                            </td>
                          </tr>
                        );
                      })}
                      {hist.data.rows.length === 0 && (
                        <tr>
                          <td colSpan={3} style={{ textAlign: 'center', padding: 20, color: theme.color.muted }}>
                            No movements.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </DataTable>
                </ScrollX>
              </>
            )}
          </Modal>
        </Overlay>
      )}
    </Page>
  );
};

export default DaoTreasury;
