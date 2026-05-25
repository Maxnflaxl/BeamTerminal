import React from 'react';
import { styled } from '@linaria/react';
import { TradePool } from '@app/containers/Pools/containers/TradePool';

const Wrapper = styled.div`
  width: 100%;
  min-width: 0;
  max-width: 100%;
  overflow-x: hidden;
`;

export const SwapPoolsHome = () => (
  <Wrapper>
    <TradePool embedded />
  </Wrapper>
);
