import React from 'react';
import { styled } from '@linaria/react';
import type { ApiStats } from '../api/types';
import { fmt$, fmtNum } from './format';
import { BeamIcon } from '@app/shared/icons';

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
    padding: 12px;
    display: grid;
    grid-template-columns: 1fr 1fr;
    grid-gap: 8px;
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
    padding: 10px 12px;
    border-right: none;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 10px;
    &:last-child {
      padding: 10px 12px;
    }
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
  svg {
    width: 16px;
    height: 16px;
    vertical-align: middle;
    margin-right: 6px;
    position: relative;
    top: -1px;
  }
  b {
    color: white;
    margin-left: 4px;
  }

  @media (max-width: 640px) {
    margin-left: 0;
    display: flex;
    flex-direction: column;
    justify-content: center;
    padding: 10px 12px;
    background: rgba(0, 246, 210, 0.08);
    border: 1px solid rgba(0, 246, 210, 0.28);
    border-radius: 10px;
    svg {
      width: 14px;
      height: 14px;
      margin-right: 5px;
    }
    b {
      margin-left: 0;
      margin-top: 2px;
      font-family: 'SFProDisplay', monospace;
      font-size: 15px;
      font-weight: 600;
    }
  }
`;

// Wraps the icon + "BEAM" so the price tile can stack label-over-value on
// mobile while staying inline ("◈ BEAM $0.01") on desktop.
const BeamLabel = styled.span`
  white-space: nowrap;

  @media (max-width: 640px) {
    display: flex;
    align-items: center;
    font-size: 11px;
    letter-spacing: 0.5px;
    text-transform: uppercase;
    color: rgba(255, 255, 255, 0.6);
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
        <BeamLabel>
          <BeamIcon />
          BEAM
        </BeamLabel>
        {' '}
        <b>{stats ? fmt$(stats.beam_usd) : '$—'}</b>
      </BeamPx>
    </Row>
  </Bar>
);
