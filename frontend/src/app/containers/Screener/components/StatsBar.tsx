import React from 'react';
import { styled } from '@linaria/react';
import type { ApiStats } from '../api/types';
import { MOBILE_MEDIA } from './responsive';
import { fmt$, fmtNum } from './format';
import { BeamIcon } from '@app/shared/icons';

const Bar = styled.div`
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  padding: 10px 0;
`;

const Row = styled.div`
  max-width: 1400px;
  margin: 0 auto;
  padding: 0 20px;
  display: flex;
  align-items: center;
  flex-wrap: wrap;

  ${MOBILE_MEDIA} {
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

  ${MOBILE_MEDIA} {
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

// The BEAM/USD price gets its own teal-accented tile so it reads as the headline
// number (the other stats stay plain). Stacked label-over-value like the stat cells.
const BeamPx = styled.div`
  margin-left: auto;
  display: flex;
  flex-direction: column;
  padding: 8px 14px;
  background: rgba(0, 246, 210, 0.1);
  border: 1px solid rgba(0, 246, 210, 0.3);
  border-radius: 9px;
  white-space: nowrap;
  svg {
    width: 14px;
    height: 14px;
    vertical-align: middle;
    margin-right: 5px;
    position: relative;
    top: -1px;
  }
  b {
    color: #fff;
    font-family: 'SFProDisplay', monospace;
    font-size: 15px;
    font-weight: 600;
    margin-top: 3px;
  }

  ${MOBILE_MEDIA} {
    margin-left: 0;
  }
`;

// The tile's label ("◈ BEAM"), teal to match the tile, stacked above the price.
const BeamLabel = styled.span`
  display: flex;
  align-items: center;
  font-size: 11px;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  color: #00f6d2;
  white-space: nowrap;
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
        <b>{stats ? fmt$(stats.beam_usd) : '$—'}</b>
      </BeamPx>
    </Row>
  </Bar>
);
