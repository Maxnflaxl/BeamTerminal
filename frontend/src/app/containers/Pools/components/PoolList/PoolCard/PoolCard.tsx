import React, {
  memo, useCallback, useEffect, useState,
} from 'react';

import { IPoolCard } from '@core/types';
import {
  convertLowAmount, fromGroths, getPoolKind, truncate,
} from '@core/appUtils';
import { ROUTES_PATH } from '@app/shared/constants';
import { useNavigate } from 'react-router-dom';
import { useDispatch } from 'react-redux';
import * as mainActions from '@app/containers/Pools/store/actions';
import { Button, Section } from '@app/shared/components';
import { styled } from '@linaria/react';
import {
  IconExchange,
  IconExchangeTrade,
  IconFavorite,
  IconFavoriteFilled,
  IconReceive,
  IconShieldChecked,
} from '@app/shared/icons';
import AssetLabel from '@app/shared/components/AssetLabel';

interface PoolCardType {
  data: IPoolCard;
  isFavorite?: boolean;
}

const HeaderCardWrapper = styled.div`
  position: relative;
  display: flex;
  width: 100%;
`;
const TitleWrapper = styled.div`
  display: flex;
  justify-content: flex-start;
  width: 100%;
  align-self: center;
  line-height: 17px;
  margin-bottom: 20px;
  & > span {
    display: flex;
    font-weight: 700;
    font-size: 14px;
    line-height: 17px;
    letter-spacing: 3.11111px;
    text-transform: uppercase;
    color: white;
  }
`;
const Title = styled.div`
  display: flex;
  font-weight: 700;
  font-size: 14px;
  line-height: 17px;
  letter-spacing: 3.11111px;
  text-transform: uppercase;
  color: white;
`;
const Fav = styled.div`
  position: absolute;
  align-items: center;
  top: -3px;
  right: 0;
  height: 22px;
  display: flex;
  justify-content: space-between;
  width: 170px;
  cursor: pointer;
`;
const Kind = styled.div`
  margin-right: 3px;
  background: rgba(255, 255, 255, 0.05);
  padding: 4px 8px;
  border-radius: 20px;
  font-weight: 400;
  font-size: 14px;
  line-height: 14px;
`;
const AmountWrapper = styled.div`
  display: flex;
  width: 100%;
  height: 50px;
  justify-content: flex-start;
  margin-bottom: 20px;
`;
const AssetAmount = styled.div`
  font-weight: 400;
  font-size: 14px;
  line-height: 17px;
  color: white;
`;
const ControlWrapper = styled.div`
  width: 100%;
  display: flex;
  justify-content: space-between;
  margin: 30px 0 20px 0;
`;
const Line = styled.div`
  width: 100%;
  background-color: var(--color-opasity-0-1);
  height: 1px;
  border-radius: 2px;
`;
const SideLeftWrap = styled.div`
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  align-items: flex-start;
  width: 100%;
`;
const SideRightWrap = styled.div`
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  align-items: flex-end;
  width: 100%;
`;

const ButtonWrapper = styled.div`
  width: 298px;
  padding: 0 20px;
`;

export const PoolCard = memo(({ data, isFavorite }: PoolCardType) => {
  const nameToken1 = truncate(data?.metadata1?.UN || `Token ${data?.aid1 ?? ''}`);
  const nameToken2 = truncate(data?.metadata2?.UN || `Token ${data?.aid2 ?? ''}`);
  const navigate = useNavigate();
  const dispatch = useDispatch();
  const [poolIsEmpty, setPoolIsEmpty] = useState(true);
  const currentCourseMain = `
  1 ${nameToken2} = ${truncate(convertLowAmount(data.k1_2).toString(), 9)} ${nameToken1}`;
  const currentCourseSecond = `
  1 ${nameToken1} = ${truncate(convertLowAmount(data.k2_1).toString(), 9)} ${nameToken2}`;
  const [exchange, setExchange] = useState(currentCourseMain);

  useEffect(() => {
    setPoolIsEmpty(!!(!data.tok1 || !data.tok2));
  }, [data.tok1, data.tok2]);

  const addLiquidityNavigation = useCallback(() => {
    dispatch(mainActions.setCurrentPool(data));
    dispatch(mainActions.setPredict(null));
    navigate(ROUTES_PATH.POOLS.ADD_LIQUIDITY);
  }, [dispatch, data, navigate]);

  const tradePoolNavigation = useCallback(() => {
    dispatch(mainActions.setCurrentPool(data));
    dispatch(mainActions.setPredict(null));
    navigate(ROUTES_PATH.POOLS.TRADE_POOL);
  }, [dispatch, data, navigate]);

  const withdrawPoolNavigation = useCallback(() => {
    dispatch(mainActions.setCurrentPool(data));
    dispatch(mainActions.setPredict(null));
    navigate(ROUTES_PATH.POOLS.WITHDRAW_POOL);
  }, [dispatch, data, navigate]);

  const changeCourse = () => {
    setExchange(exchange !== currentCourseMain ? currentCourseMain : currentCourseSecond);
  };

  const handleFavorite = (card: IPoolCard) => {
    dispatch(mainActions.onFavorites.request(card));
  };

  const formatNumber = (num: string | number): string => {
    const parsedNum = typeof num === 'number' ? num : Number(num);
    return parsedNum.toLocaleString('en-US');
  };

  // TODO: break down into components
  return (
    <Section variant="card">
      <HeaderCardWrapper>
        <TitleWrapper>
          <Title>{nameToken1}</Title>
          <span> / </span>
          <Title>{nameToken2}</Title>
        </TitleWrapper>
        <Fav>
          <AssetLabel assets_id={data['lp-token']} />
          <Kind>{`${getPoolKind(data.kind)}`}</Kind>
          {isFavorite ? (
            <IconFavoriteFilled onClick={() => handleFavorite(data)} />
          ) : (
            <IconFavorite onClick={() => handleFavorite(data)} />
          )}
        </Fav>
      </HeaderCardWrapper>
      <AmountWrapper>
        <SideLeftWrap>
          <AssetLabel title={nameToken1} assets_id={data.aid1} id variant="predict" />
          <AssetLabel title={nameToken2} assets_id={data.aid2} id variant="predict" />
        </SideLeftWrap>
        <SideRightWrap>
          <AssetAmount>{formatNumber(fromGroths(data.tok1))}</AssetAmount>
          <AssetAmount>{formatNumber(fromGroths(data.tok2))}</AssetAmount>
        </SideRightWrap>
      </AmountWrapper>
      <Section variant="exchange">
        {!poolIsEmpty ? (
          <>
            <div style={{ textTransform: 'uppercase' }}>{exchange}</div>
            <Button icon={IconExchange} variant="icon" onClick={() => changeCourse()} />
            {' '}
          </>
        ) : (
          <Line />
        )}
      </Section>
      <ControlWrapper>
        <Button icon={IconShieldChecked} variant="control" onClick={addLiquidityNavigation}>
          add liquidity
        </Button>
        <Button
          disabled={!!poolIsEmpty}
          icon={IconReceive}
          variant="control"
          pallete="blue"
          onClick={withdrawPoolNavigation}
        >
          withdraw
        </Button>
      </ControlWrapper>
      <ButtonWrapper>
        <Button
          variant="trade"
          icon={IconExchangeTrade}
          pallete="green"
          onClick={tradePoolNavigation}
          disabled={!!poolIsEmpty}
        >
          trade
        </Button>
      </ButtonWrapper>
    </Section>
  );
});
