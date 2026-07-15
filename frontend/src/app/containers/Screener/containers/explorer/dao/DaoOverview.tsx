import React from 'react';
import { Link } from 'react-router-dom';
import { styled } from '@linaria/react';
import { css } from '@linaria/core';
import { ROUTES } from '@app/shared/constants';
import { Page, ExplorerHeader, H1, Subtitle, ErrorBox, theme } from '../shared';
import { usePolled } from '../../../hooks';
import { api } from '../../../api/client';
import type { ApiDaoOverview } from '../../../api/types';
import { fmtUsd } from './daoShared';

const Cards = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  grid-gap: 16px;
  margin-bottom: 20px;
`;
const hubCls = css`
  display: block;
  color: inherit;
  text-decoration: none;
  background: ${theme.color.surface};
  border: 1px solid ${theme.color.borderDim};
  border-radius: ${theme.radius.lg};
  padding: 18px;
  transition: border-color 0.15s;
  &:hover {
    border-color: ${theme.color.accent};
  }
`;
const CardLabel = styled.div`
  font-size: 11px;
  color: ${theme.color.muted};
  text-transform: uppercase;
  letter-spacing: 0.05em;
`;
const CardValue = styled.div`
  font-size: 24px;
  font-weight: 700;
  color: ${theme.color.accent};
  margin: 6px 0 2px;
  font-variant-numeric: tabular-nums;
`;
const CardSub = styled.div`
  font-size: 12px;
  color: ${theme.color.muted};
`;
const ViewLink = styled.div`
  font-size: 11px;
  color: ${theme.color.accent};
  margin-top: 14px;
`;

export const DaoOverview: React.FC = () => {
  const { data: d, error } = usePolled<ApiDaoOverview>(() => api.daoOverview(), [], 60_000);

  return (
    <Page>
      <ExplorerHeader>
        <div>
          <H1>DAO Explorer</H1>
          <Subtitle>BeamX DAO · Treasury · Revenue · Governance</Subtitle>
        </div>
      </ExplorerHeader>

      {error && (
        <ErrorBox>
          Failed to load DAO overview:
          {error}
        </ErrorBox>
      )}

      <Cards>
        <Link to={ROUTES.NAV.EXPLORER_DAO_TREASURY} className={hubCls}>
          <CardLabel>Treasury</CardLabel>
          <CardValue>{fmtUsd(d?.treasury.value_usd ?? null)}</CardValue>
          <CardSub>{d?.treasury.assets ?? 0} assets held</CardSub>
          <ViewLink>View treasury →</ViewLink>
        </Link>
        <Link to={ROUTES.NAV.EXPLORER_DAO_REVENUE} className={hubCls}>
          <CardLabel>Revenue (all-time)</CardLabel>
          <CardValue>{fmtUsd(d?.revenue.all_time_usd ?? null)}</CardValue>
          <CardSub>revenue from DAO DeFi dapps</CardSub>
          <ViewLink>View revenue →</ViewLink>
        </Link>
        <Link to={ROUTES.NAV.EXPLORER_DAO_GOVERNANCE} className={hubCls}>
          <CardLabel>Governance</CardLabel>
          <CardValue>{d?.governance.current_epoch != null ? `Epoch #${d.governance.current_epoch}` : '—'}</CardValue>
          <CardSub>{d?.governance.active_proposals ?? 0} live proposals</CardSub>
          <ViewLink>View governance →</ViewLink>
        </Link>
      </Cards>
    </Page>
  );
};

export default DaoOverview;
