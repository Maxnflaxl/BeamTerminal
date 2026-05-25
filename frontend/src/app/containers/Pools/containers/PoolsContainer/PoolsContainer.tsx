import React from 'react';
import { useRoutes } from 'react-router-dom';
import { ROUTES_PATH } from '@app/shared/constants';
import { CreatePool } from '@app/containers/Pools/containers/CreatePool';
import { AddLiquidity } from '@app/containers/Pools/containers/AddLiquidity';
import { TradePool } from '@app/containers/Pools/containers/TradePool';
import { WithdrawPool } from '@app/containers/Pools/containers/WithdrawPool';
import { SwapPoolsHome } from '@app/containers/Pools/containers/SwapPoolsHome';

const routes = [
  {
    path: ROUTES_PATH.POOLS.BASE,
    element: <SwapPoolsHome />,
    exact: true,
  },
  {
    path: ROUTES_PATH.POOLS.CREATE_POOL,
    element: <CreatePool />,
    exact: true,
  },
  {
    path: ROUTES_PATH.POOLS.ADD_LIQUIDITY,
    element: <AddLiquidity />,
    exact: true,
  },
  {
    path: ROUTES_PATH.POOLS.TRADE_POOL,
    element: <TradePool />,
    exact: true,
  },
  {
    path: ROUTES_PATH.POOLS.WITHDRAW_POOL,
    element: <WithdrawPool />,
    exact: true,
  },
];

export const PoolsContainer = () => {
  const content = useRoutes(routes);
  return <>{content}</>;
};
