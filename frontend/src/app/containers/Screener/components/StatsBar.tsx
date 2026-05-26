import React from 'react';
import { styled } from '@linaria/react';
import type { ApiStats } from '../api/types';
import { fmt$, fmtNum } from './format';

const Bar = styled.div`
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  background: rgba(255, 255, 255, 0.02);
  padding: 10px 0;
`;

const Row = styled.div`
  max-width: 1400px;
  margin: 0 auto;
  padding: 0 20px;
  display: flex;
  align-items: center;
  flex-wrap: wrap;

  @media (max-width: 640px) {
    padding: 0 12px;
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 10px 12px;
  }
`;

const Stat = styled.div`
  margin-right: 24px;
  padding-right: 24px;
  border-right: 1px solid rgba(255, 255, 255, 0.08);
  white-space: nowrap;
  &:last-child {
    border-right: none;
    margin-right: 0;
    padding-right: 0;
  }

  @media (max-width: 640px) {
    margin-right: 0;
    padding-right: 0;
    border-right: none;
  }
`;

const Label = styled.div`
  font-size: 11px;
  color: rgba(255, 255, 255, 0.5);
  text-transform: uppercase;
  letter-spacing: 0.5px;
`;

const Value = styled.div`
  font-family: 'SFProDisplay', monospace;
  font-size: 15px;
  font-weight: 600;
  color: white;
`;

const BeamPx = styled.div`
  margin-left: auto;
  font-size: 13px;
  color: rgba(255, 255, 255, 0.6);
  white-space: nowrap;
  b {
    color: white;
    margin-left: 4px;
  }

  @media (max-width: 640px) {
    margin-left: 0;
    grid-column: 1 / -1;
    padding-top: 4px;
    border-top: 1px solid rgba(255, 255, 255, 0.06);
  }
`;

interface Props {
  stats: ApiStats | null;
}

export const StatsBar: React.FC<Props> = ({ stats }) => (
  <Bar>
    <Row>
      <Stat>
        <Label>Total TVL</Label>
        <Value>{stats ? fmt$(stats.total_tvl_usd) : '$—'}</Value>
      </Stat>
      <Stat>
        <Label>24h Volume</Label>
        <Value>{stats ? fmt$(stats.volume_24h_usd) : '$—'}</Value>
      </Stat>
      <Stat>
        <Label>Total Volume</Label>
        <Value>{stats ? fmt$(stats.total_volume_usd) : '$—'}</Value>
      </Stat>
      <Stat>
        <Label>Active Pairs</Label>
        <Value>{stats ? fmtNum(stats.total_pairs, 0) : '—'}</Value>
      </Stat>
      <Stat>
        <Label>Total Trades</Label>
        <Value>{stats ? stats.total_trades.toLocaleString('en-US') : '—'}</Value>
      </Stat>
      <BeamPx>
        BEAM
        {' '}
        <b>{stats ? fmt$(stats.beam_usd) : '$—'}</b>
      </BeamPx>
    </Row>
  </Bar>
);
