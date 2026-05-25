import React from 'react';
import { styled } from '@linaria/react';
import { useNavigate } from 'react-router-dom';
import { useSelector } from 'react-redux';
import {
  Button, Container, PoolStat, Window,
} from '@app/shared/components';
import { ROUTES } from '@app/shared/constants';
import { selectAssetsList, selectCurrentPool } from '@app/containers/Pools/store/selectors';
import { getLPToken } from '@core/appUtils';
import { IconReceive, IconShieldChecked } from '@app/shared/icons';

const Wrapper = styled.div`
  width: 100%;
  max-width: 540px;
  min-height: 0;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.02);
  padding: 14px;
  display: flex;
  flex-direction: column;
  margin: 0 auto;
`;
const Actions = styled.div`
  width: 100%;
  display: flex;
  gap: 8px;
  margin-top: 14px;
`;

export const PoolView = () => {
  const navigate = useNavigate();
  const pool = useSelector(selectCurrentPool());
  const assets = useSelector(selectAssetsList());
  const lpToken = pool ? getLPToken(pool, assets) : null;

  return (
    <Window hideHeader>
      <Container>
        {pool ? (
          <Wrapper>
            <PoolStat data={pool} lp={lpToken} showFavorite plain />
            <Actions>
              <Button icon={IconShieldChecked} variant="control" onClick={() => navigate(ROUTES.POOLS.ADD_LIQUIDITY)}>
                Add Liquidity
              </Button>
              <Button
                icon={IconReceive}
                variant="control"
                pallete="blue"
                onClick={() => navigate(ROUTES.POOLS.WITHDRAW_POOL)}
              >
                Withdraw
              </Button>
            </Actions>
          </Wrapper>
        ) : 'Select a pool from Trade first.'}
      </Container>
    </Window>
  );
};

export default PoolView;
