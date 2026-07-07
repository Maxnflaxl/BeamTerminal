import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { styled } from '@linaria/react';
import { css } from '@linaria/core';
import { Page, ExplorerHeader, H1, Subtitle, StatGrid, StatCard, Label, Value, Pill, ErrorBox, theme } from '../shared';
import { ROUTES } from '@app/shared/constants';
import { api } from '../../../api/client';
import type { ApiDaoGovernance, ApiDaoProposalSummary } from '../../../api/types';
import { TallyBar, TimeChart, fmtBeamx, fmtCompact, grothToBeamx, variantColor, outcomeTone, outcomeLabel } from './daoShared';

const POLL_MS = 60_000;

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
const EpochLabel = styled.div`
  font-size: 12px;
  font-weight: 700;
  color: ${theme.color.muted};
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin: 20px 0 10px;
`;
const Card = styled.div`
  background: ${theme.color.surface};
  border: 1px solid ${theme.color.borderDim};
  border-radius: ${theme.radius.lg};
  padding: 14px 16px;
  margin-bottom: 10px;
`;
const TopRow = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  & > * + * { margin-left: 12px; }
`;
const PTitle = styled.div`
  font-size: 14px;
  font-weight: 700;
  color: ${theme.color.text};
`;
const PMeta = styled.div`
  font-size: 11px;
  color: ${theme.color.muted};
  margin-top: 3px;
`;
const BottomRow = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
`;
const Legend = styled.div`
  display: flex;
  flex-wrap: wrap;
  font-size: 11px;
  color: ${theme.color.muted};
  & > * + * { margin-left: 14px; }
`;
const LegendItem = styled.span`
  display: inline-flex;
  align-items: center;
  & > i {
    width: 8px;
    height: 8px;
    border-radius: 2px;
    margin-right: 5px;
    display: inline-block;
  }
`;
const detailsCls = css`
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  font-weight: 600;
  padding: 6px 14px;
  border-radius: 6px;
  border: 1px solid ${theme.color.border};
  background: ${theme.color.surface2};
  color: ${theme.color.accent};
  text-decoration: none;
  transition: background 0.15s, border-color 0.15s;
  &:hover {
    background: ${theme.color.rowHover};
    border-color: ${theme.color.accent};
    color: ${theme.color.accent};
  }
`;

const ProposalCardView: React.FC<{ p: ApiDaoProposalSummary }> = ({ p }) => (
  <Card>
    <TopRow>
      <PTitle>{p.title ?? `Proposal #${p.id}`}</PTitle>
      <Pill data-tone={outcomeTone(p.status, p.outcome)}>{outcomeLabel(p.status, p.outcome)}</Pill>
    </TopRow>
    <PMeta>
      {`#${String(p.id).padStart(4, '0')} · ${p.variant_count} options`}
      {p.quorum_pct != null ? ` · quorum ${p.quorum_pct}%` : ''}
      {p.turnout_pct != null ? ` · turnout ${p.turnout_pct.toFixed(1)}%` : ''}
    </PMeta>
    <TallyBar tallies={p.tallies} />
    <BottomRow>
      <Legend>
        {p.tallies.map((t) => (
          <LegendItem key={t.variant}>
            <i style={{ background: variantColor(t.variant) }} />
            {`${t.label} ${t.pct.toFixed(0)}% · ${fmtCompact(grothToBeamx(t.stake))}`}
          </LegendItem>
        ))}
      </Legend>
      <Link to={ROUTES.NAV.DAO_PROPOSAL.replace(':id', String(p.id))} className={detailsCls}>
        Details →
      </Link>
    </BottomRow>
  </Card>
);

export const DaoGovernance: React.FC = () => {
  const [data, setData] = useState<ApiDaoGovernance | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = (): void => {
      api
        .daoGovernance()
        .then((d) => {
          if (alive) {
            setData(d);
            setError(null);
          }
        })
        .catch((e: unknown) => {
          if (alive) setError(e instanceof Error ? e.message : String(e));
        });
    };
    load();
    const id = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const byEpoch = useMemo(() => {
    const m = new Map<number, ApiDaoProposalSummary[]>();
    for (const p of data?.proposals ?? []) {
      const arr = m.get(p.epoch) ?? [];
      arr.push(p);
      m.set(p.epoch, arr);
    }
    return [...m.entries()].sort((a, b) => b[0] - a[0]);
  }, [data]);

  return (
    <Page>
      <ExplorerHeader>
        <div>
          <H1>Governance</H1>
          <Subtitle>BeamX DAO · Proposals &amp; Voting</Subtitle>
        </div>
      </ExplorerHeader>

      {error && <ErrorBox>Failed to load governance: {error}</ErrorBox>}

      <StatGrid>
        <StatCard>
          <Label>Current epoch</Label>
          <Value style={{ color: theme.color.accent }}>{data?.current_epoch != null ? `#${data.current_epoch}` : '—'}</Value>
        </StatCard>
        <StatCard>
          <Label>Live proposals</Label>
          <Value>{data?.kpis.active_proposals ?? 0}</Value>
        </StatCard>
        <StatCard>
          <Label>Voting power</Label>
          <Value>{fmtBeamx(data?.total_staked ?? 0)}</Value>
        </StatCard>
        <StatCard>
          <Label>Total proposals</Label>
          <Value>{data?.proposals.length ?? 0}</Value>
        </StatCard>
      </StatGrid>

      <Panel>
        <PanelHead>Voting power staked over time (BEAMX)</PanelHead>
        <div style={{ padding: '14px 16px' }}>
          <TimeChart
            data={(data?.voting_power_series ?? []).map((s) => ({ label: s.day, value: s.staked }))}
            fmtY={fmtCompact}
          />
        </div>
      </Panel>

      {byEpoch.map(([epoch, props]) => (
        <div key={epoch}>
          <EpochLabel>Epoch #{epoch}</EpochLabel>
          {props.map((p) => (
            <ProposalCardView key={p.id} p={p} />
          ))}
        </div>
      ))}
    </Page>
  );
};

export default DaoGovernance;
