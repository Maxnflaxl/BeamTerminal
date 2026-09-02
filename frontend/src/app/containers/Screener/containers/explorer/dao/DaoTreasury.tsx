import React, { useCallback, useState } from 'react';
import { styled } from '@linaria/react';
import AssetIcon, { useAssetColorResolver } from '@app/shared/components/AssetsIcon';
import { BlockHeight } from '@app/shared/components';
import { Overlay, useEscapeClose } from '../../../components/modalChrome';
import { usePolled } from '../../../hooks';
import { useSharedAssetIndex } from '../../../assetColors';
import {
  Page,
  ExplorerHeader,
  H1,
  Subtitle,
  StatGrid,
  StatCard,
  Label,
  Value,
  DataTable,
  ScrollX,
  Btn,
  ErrorBox,
  theme,
  Donut,
} from '../shared';
import type { DonutSlice } from '../shared';
import { fromGroths, fromGrothsStr } from '../../../components/format';
import { api } from '../../../api/client';
import type { ApiDaoTreasury, ApiDaoAssetHistory } from '../../../api/types';
import { TimeChart, fmtUsd, fmtCompact } from './daoShared';

const FLOWS_PER_PAGE = 12;
const DONUT_MAX_SLICES = 8;

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
  & b {
    color: ${theme.color.text};
    font-weight: 600;
  }
  & small {
    color: ${theme.color.muted};
    margin-left: 8px;
    font-size: 11px;
  }
`;
const ClickRow = styled.tr`
  cursor: pointer;
  &:hover {
    background: ${theme.color.rowHover};
  }
`;
const FlowRow = styled.div`
  display: grid;
  grid-template-columns: 110px 96px 1fr;
  grid-gap: 12px;
  padding: 9px 16px;
  border-bottom: 1px solid ${theme.color.borderDim};
  font-size: 12px;
  align-items: center;
  &:last-child {
    border-bottom: 0;
  }
`;
const FundTag = styled.span`
  display: inline-flex;
  align-items: center;
  margin-right: 12px;
  font-variant-numeric: tabular-nums;
`;
const Pagination = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  border-top: 1px solid ${theme.color.borderDim};
  font-size: 12px;
`;
const PageInfo = styled.div`
  color: ${theme.color.muted};
  font-variant-numeric: tabular-nums;
`;
const PageBtns = styled.div`
  display: flex;
  & > * + * {
    margin-left: 6px;
  }
`;
const Modal = styled.div`
  width: 92%;
  max-width: 760px;
  max-height: 86vh;
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
const ModalTitle = styled.span`
  display: flex;
  align-items: baseline;
  & small {
    margin-left: 10px;
    font-weight: 400;
    font-size: 12px;
    color: ${theme.color.muted};
  }
`;
const Closer = styled.button`
  background: none;
  border: 0;
  color: ${theme.color.muted};
  font-size: 18px;
  cursor: pointer;
  &:hover {
    color: ${theme.color.text};
  }
`;
// Horizontal composition: the donut sits left/top, the legend fills the rest as
// a responsive multi-column grid so a long holdings list reads wide, not as one
// tall single-file stack. The body scrolls as a whole on short viewports.
// (Flex `gap` is unsupported on the wallet's Chromium 83 — space with margins.)
const DonutBody = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  padding: 20px;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
`;
const DonutAside = styled.div`
  flex-shrink: 0;
  width: 200px;
  margin: 0 26px 16px 0;
  display: flex;
  flex-direction: column;
  align-items: center;
`;
const DonutNote = styled.div`
  margin-top: 8px;
  font-size: 11px;
  color: ${theme.color.muted};
  text-align: center;
`;
// Multi-column (not grid) so the list reads column-major — down the first
// column, then the second — instead of row-major (1,2 / 3,4). `break-inside`
// keeps a row from splitting across the column boundary.
const DLegend = styled.div`
  flex: 1 1 300px;
  min-width: 240px;
  column-width: 230px;
  column-gap: 24px;
  font-size: 12px;
`;
const DLegendRow = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 5px 0;
  border-bottom: 1px solid ${theme.color.borderDim};
  cursor: pointer;
  break-inside: avoid;
  &:hover {
    color: ${theme.color.accent};
  }
  & .l {
    display: flex;
    align-items: center;
    min-width: 0;
  }
  & .l b {
    font-weight: 600;
  }
  & .r {
    color: ${theme.color.muted};
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    margin-left: 10px;
  }
`;
const HistSummary = styled.div`
  padding: 12px 16px;
  border-bottom: 1px solid ${theme.color.borderDim};
  font-size: 12px;
  display: flex;
  /* Owl margins, not gap — flex gap is unsupported in the wallet's Chrome 83. */
  & > * + * {
    margin-left: 18px;
  }
`;

export const DaoTreasury: React.FC = () => {
  const treasury = usePolled<ApiDaoTreasury>(() => api.daoTreasury(), [], 60_000);
  const d = treasury.data;
  const { error } = treasury;
  const meta = useSharedAssetIndex();
  const [donut, setDonut] = useState(false);
  const [hist, setHist] = useState<{ aid: number; data: ApiDaoAssetHistory | null } | null>(null);
  const closeHist = useCallback(() => setHist(null), []);
  const closeDonut = useCallback(() => setDonut(false), []);
  // The history modal stacks above the donut modal — it takes ESC precedence.
  useEscapeClose(closeHist, hist !== null);
  useEscapeClose(closeDonut, hist === null && donut);
  const [flowPage, setFlowPage] = useState(0);
  const [donutHoverKey, setDonutHoverKey] = useState<string | null>(null);

  const assetColor = useAssetColorResolver();

  const symOf = (aid: number): string => meta.get(aid)?.short_name ?? `aid ${aid}`;
  const nameOf = (aid: number): string | null => meta.get(aid)?.name ?? null;
  // Colour donut slices / legend swatches exactly the way AssetIcon paints the
  // glyph, so a slice always matches its icon (same OPT_COLOR → palette chain).
  const colorOf = (aid: number): string => assetColor(aid, meta.get(aid)?.color);
  const fmtAmt = (groth: string, aid: number): string => {
    const dec = meta.get(aid)?.decimals ?? 8;
    return fmtCompact(fromGroths(groth, dec));
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

  // Donut: rank by share, keep the top slices legible, and roll the long tail
  // into a single neutral "Other" wedge rather than rendering ~20 invisible
  // slivers. Each kept slice carries its asset's brand colour.
  const rankedPriced = [...priced].sort((a, b) => b.pct - a.pct);
  const donutTop = rankedPriced.slice(0, DONUT_MAX_SLICES);
  const donutRest = rankedPriced.slice(DONUT_MAX_SLICES);
  const restPct = donutRest.reduce((s, h) => s + h.pct, 0);
  const restUsd = donutRest.reduce((s, h) => s + (h.value_usd ?? 0), 0);

  // Donut slices: each top holding in its asset's brand colour + a neutral
  // "Other" wedge for the long tail. `detail` shows the USD value on hover.
  const donutTopKeys = new Set(donutTop.map((h) => String(h.aid)));
  const donutSlices: DonutSlice[] = [
    ...donutTop.map((h) => ({
      key: String(h.aid),
      label: symOf(h.aid),
      color: colorOf(h.aid),
      value: h.pct,
      detail: `${h.pct.toFixed(2)}% · ${fmtUsd(h.value_usd)}`,
    })),
    ...(restPct > 0.0001
      ? [
          {
            key: 'other',
            label: 'Other',
            color: theme.color.muted2,
            value: restPct,
            detail: `${donutRest.length} assets · ${restPct.toFixed(2)}% · ${fmtUsd(restUsd)}`,
          },
        ]
      : []),
  ];
  // A tail asset hovered in the legend lights up the "Other" wedge it's part of.
  const sliceKeyForAid = (aid: number): string => (donutTopKeys.has(String(aid)) ? String(aid) : 'other');

  const flows = d?.flows ?? [];
  const flowPages = Math.max(1, Math.ceil(flows.length / FLOWS_PER_PAGE));
  const safeFlowPage = Math.min(flowPage, flowPages - 1);
  const flowStart = safeFlowPage * FLOWS_PER_PAGE;
  const pageFlows = flows.slice(flowStart, flowStart + FLOWS_PER_PAGE);

  return (
    <Page>
      <ExplorerHeader>
        <div>
          <H1>Treasury</H1>
          <Subtitle>DAO Vault · Holdings &amp; value</Subtitle>
        </div>
      </ExplorerHeader>

      {error && (
        <ErrorBox>
          Failed to load treasury:
          {error}
        </ErrorBox>
      )}

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
          {pageFlows.map((f, i) => (
            <FlowRow key={`${f.height}-${flowStart + i}`}>
              <span style={{ color: theme.color.muted }}>
                h <BlockHeight height={f.height} />
              </span>
              <span>{f.method}</span>
              <span>
                {Object.entries(f.funds).map(([aid, amt]) => {
                  const id = Number(aid);
                  const dec = meta.get(id)?.decimals ?? 8;
                  const neg = amt.trim().startsWith('-');
                  return (
                    <FundTag key={aid} style={{ color: neg ? theme.color.danger : theme.color.accent }}>
                      <AssetIcon asset_id={id} color={meta.get(id)?.color} size={14} />
                      {neg ? '' : '+'}
                      {fromGrothsStr(amt, dec)} {symOf(id)}
                    </FundTag>
                  );
                })}
              </span>
            </FlowRow>
          ))}
          {flows.length === 0 && (
            <div
              style={{
                textAlign: 'center',
                padding: 22,
                color: theme.color.muted,
                fontSize: 12,
              }}
            >
              No recent flows.
            </div>
          )}
        </div>
        {flows.length > FLOWS_PER_PAGE && (
          <Pagination>
            <PageInfo>
              {flowStart + 1}–{Math.min(flowStart + FLOWS_PER_PAGE, flows.length)} of
              {flows.length}
            </PageInfo>
            <PageBtns>
              <Btn type="button" data-variant="ghost" disabled={safeFlowPage === 0} onClick={() => setFlowPage(0)}>
                ⏮
              </Btn>
              <Btn
                type="button"
                data-variant="ghost"
                disabled={safeFlowPage === 0}
                onClick={() => setFlowPage((p) => Math.max(0, p - 1))}
              >
                ‹ Prev
              </Btn>
              <Btn
                type="button"
                data-variant="ghost"
                disabled={safeFlowPage >= flowPages - 1}
                onClick={() => setFlowPage((p) => Math.min(flowPages - 1, p + 1))}
              >
                Next ›
              </Btn>
              <Btn
                type="button"
                data-variant="ghost"
                disabled={safeFlowPage >= flowPages - 1}
                onClick={() => setFlowPage(flowPages - 1)}
              >
                ⏭
              </Btn>
            </PageBtns>
          </Pagination>
        )}
      </Panel>

      {donut && (
        <Overlay z={50} backdrop="rgba(2, 12, 24, 0.8)" pad="0" onClick={closeDonut}>
          <Modal onClick={(e) => e.stopPropagation()}>
            <ModalHead>
              <ModalTitle>
                Holdings composition
                <small>{priced.length} priced assets</small>
              </ModalTitle>
              <Closer type="button" onClick={() => setDonut(false)}>
                ✕
              </Closer>
            </ModalHead>
            <DonutBody>
              <DonutAside>
                <Donut
                  slices={donutSlices}
                  size={200}
                  gap={2}
                  thickness={30}
                  idlePrimary={fmtUsd(d?.total_usd ?? null)}
                  idleSecondary="TOTAL"
                  activeKey={donutHoverKey}
                  onActiveChange={setDonutHoverKey}
                  onSliceClick={(key) => {
                    if (key !== 'other') {
                      setDonut(false);
                      openAsset(Number(key));
                    }
                  }}
                />
                {restPct > 0.0001 && (
                  <DonutNote>
                    <span style={{ color: theme.color.muted2 }}>■</span> Other ={donutRest.length} assets ·{' '}
                    {restPct.toFixed(2)}%
                  </DonutNote>
                )}
              </DonutAside>
              <DLegend>
                {rankedPriced.map((h) => (
                  <DLegendRow
                    key={h.aid}
                    onClick={() => {
                      setDonut(false);
                      openAsset(h.aid);
                    }}
                    onMouseEnter={() => setDonutHoverKey(sliceKeyForAid(h.aid))}
                    onMouseLeave={() => setDonutHoverKey(null)}
                  >
                    <span className="l">
                      <AssetIcon asset_id={h.aid} color={meta.get(h.aid)?.color} size={16} />
                      <b>{symOf(h.aid)}</b>
                    </span>
                    <span className="r">
                      {h.pct.toFixed(2)}% ·{fmtAmt(h.amount, h.aid)} ·{fmtUsd(h.value_usd)}
                    </span>
                  </DLegendRow>
                ))}
              </DLegend>
            </DonutBody>
          </Modal>
        </Overlay>
      )}

      {hist && (
        <Overlay z={50} backdrop="rgba(2, 12, 24, 0.8)" pad="0" onClick={closeHist}>
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
                            <td style={{ color: theme.color.muted }}>
                              <BlockHeight height={r.height} />
                            </td>
                            <td>{r.method}</td>
                            <td
                              className="right"
                              style={{
                                color: n >= 0 ? theme.color.accent : theme.color.danger,
                                fontVariantNumeric: 'tabular-nums',
                              }}
                            >
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
