import React, { useEffect, useState } from 'react';
import { IAddLiquidity } from '@core/types';
import {
  emptyPredict, fromGroths, getLPToken, setDataRequest, toGroths, truncate,
} from '@core/appUtils';
import {
  AssetsSection, Button, Container, Input, Window,
} from '@app/shared/components';
import { useDispatch, useSelector } from 'react-redux';
import * as mainActions from '@app/containers/Pools/store/actions';
import { selectAssetsList, selectCurrentPool, selectPredirect } from '@app/containers/Pools/store/selectors';
import { useInput } from '@app/shared/hooks';
import { ROUTES } from '@app/shared/constants';
import { CancelIcon, DoneIcon } from '@app/shared/icons';
import BackNav, { PageLayout, MainCol } from '@app/shared/components/BackNav';
import AssetLabel from '@app/shared/components/AssetLabel';
import { useNavigate } from 'react-router-dom';
import { styled } from '@linaria/react';
import {
  BlockLabel, ButtonBlock, ButtonWrapper,
  EmbeddedTradeButtonWrap, InputRow, SwapBlock, SwapCard,
} from '@app/containers/Pools/containers/shared/poolFlowLayout';
import {
  createAmountFieldHandlers, formatPredictAmount, parseAmount, useAmountInputCaret,
} from '@app/containers/Pools/containers/shared/poolAmountInput';

const PageSubTitle = styled.h4`
  margin: 0 0 12px 0;
  font-size: 14px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 3px;
  color: rgba(255, 255, 255, 0.5);
`;

const LPEstimateRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  margin-top: 6px;
  margin-bottom: 12px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.02);
`;

const LPEstimateLabel = styled.span`
  font-size: 12px;
  text-transform: uppercase;
  color: rgba(255, 255, 255, 0.6);
`;

const LPEstimateValue = styled.div`
  display: flex;
  align-items: center;
`;

const LiquidityFormWrap = styled.div`
  width: 100%;
  max-width: 620px;
  min-width: 0;
  overflow-x: hidden;
  margin-top: var(--pool-embedded-layout-margin-top);
`;

export const AddLiquidity = () => {
  const data = useSelector(selectCurrentPool());
  const predictData = useSelector(selectPredirect());
  const assets = useSelector(selectAssetsList());
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const [currentLPToken, setCurrentLPToken] = useState(null);
  const [currentToken, setCurrentToken] = useState(data.aid1);
  const [requestData, setRequestData] = useState(null);
  const [poolIsEmpty, setPoolIsEmpty] = useState(true);
  const amount1 = useInput({ initialValue: 0, validations: { isEmpty: true } });
  const amount2 = useInput({ initialValue: 0, validations: { isEmpty: true } });
  const caret1 = useAmountInputCaret(amount1.value, amount1.onPredict);
  const caret2 = useAmountInputCaret(amount2.value, amount2.onPredict);
  const t1 = truncate(data?.metadata1?.UN || `Token ${data?.aid1 ?? ''}`);
  const t2 = truncate(data?.metadata2?.UN || `Token ${data?.aid2 ?? ''}`);

  useEffect(() => setPoolIsEmpty(!data.tok1 || !data.tok2), [data.tok1, data.tok2]);
  useEffect(() => setCurrentLPToken(getLPToken(data, assets)), [data, assets]);

  useEffect(() => {
    const v1 = toGroths(parseAmount(amount1.value));
    const v2 = toGroths(parseAmount(amount2.value));
    setRequestData({
      aid1: data.aid1,
      aid2: data.aid2,
      kind: data.kind,
      val1: poolIsEmpty ? v1 : (currentToken === data.aid2 ? '0' : v1),
      val2: poolIsEmpty ? v2 : (currentToken === data.aid1 ? '0' : v2),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount1.value, amount2.value, poolIsEmpty, currentToken, data.aid1, data.aid2, data.kind]);

  useEffect(() => {
    if (poolIsEmpty || !predictData) return;
    if (currentToken === data.aid1) {
      if (!emptyPredict(predictData, amount1.value)) {
        amount2.onPredict(formatPredictAmount(fromGroths(predictData.tok2)));
      }
    } else if (!emptyPredict(predictData, amount2.value)) {
      amount1.onPredict(formatPredictAmount(fromGroths(predictData.tok1)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poolIsEmpty, predictData, currentToken, data.aid1, amount1.value, amount2.value]);

  useEffect(() => {
    if (!poolIsEmpty && amount1.value === '') {
      amount2.onPredict(0);
      dispatch(mainActions.setPredict(null));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount1.value, poolIsEmpty]);

  useEffect(() => {
    if (!poolIsEmpty && amount2.value === '') {
      amount1.onPredict(0);
      dispatch(mainActions.setPredict(null));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount2.value, poolIsEmpty]);

  const checkOk = poolIsEmpty ? (amount1.isValid && amount2.isValid) : (amount1.isValid || amount2.isValid);
  const hasQuote = poolIsEmpty || (currentToken === data.aid1
    ? !emptyPredict(predictData, amount1.value)
    : !emptyPredict(predictData, amount2.value));
  const canSubmit = checkOk && amount1.value && amount2.value && hasQuote;

  useEffect(() => {
    if (checkOk && requestData) dispatch(mainActions.onAddLiquidity.request(requestData));
  }, [requestData, checkOk, dispatch]);

  const submit = (payload: IAddLiquidity) => dispatch(mainActions.onAddLiquidity.request(setDataRequest(payload)));
  const h1 = createAmountFieldHandlers(predictData, amount1, amount2.value);
  const h2 = createAmountFieldHandlers(predictData, amount2, amount1.value);

  const handleAmount1Change = (e: React.ChangeEvent<HTMLInputElement>) => {
    setCurrentToken(data.aid1);
    caret1.handleChange(e);
  };

  const handleAmount2Change = (e: React.ChangeEvent<HTMLInputElement>) => {
    setCurrentToken(data.aid2);
    caret2.handleChange(e);
  };

  const lpLabel = currentLPToken?.parsedMetadata?.UN ? truncate(currentLPToken.parsedMetadata.UN) : 'AMML';
  const lpAid = currentLPToken?.aid ?? data['lp-token'];
  const estimatedCtl = predictData?.ctl;

  const footer = (
    <EmbeddedTradeButtonWrap>
      {estimatedCtl && (
        <LPEstimateRow>
          <LPEstimateLabel>You receive (est.)</LPEstimateLabel>
          <LPEstimateValue>
            <AssetLabel title={lpLabel} assets_id={lpAid} variant="predict" amount={estimatedCtl} />
          </LPEstimateValue>
        </LPEstimateRow>
      )}
      <ButtonBlock>
        <ButtonWrapper>
          <Button icon={CancelIcon} variant="cancel" onClick={() => navigate(ROUTES.POOLS.BASE)}>Cancel</Button>
          <Button icon={DoneIcon} variant="approve" disabled={!canSubmit} onClick={() => submit(requestData)}>
            Add liquidity
          </Button>
        </ButtonWrapper>
      </ButtonBlock>
    </EmbeddedTradeButtonWrap>
  );

  const form = poolIsEmpty ? (
    <SwapCard>
      <SwapBlock>
        <BlockLabel>{t1}</BlockLabel>
        <AssetsSection>
          <InputRow>
            <Input
              ref={caret1.inputRef}
              variant="amount"
              pallete="purple"
              value={amount1.value}
              onChange={caret1.handleChange}
              onFocus={h1.onFocus}
              onBlur={h1.onBlur}
            />
            <AssetLabel title={t1} assets_id={data.aid1} />
          </InputRow>
        </AssetsSection>
      </SwapBlock>
      <SwapBlock>
        <BlockLabel>{t2}</BlockLabel>
        <AssetsSection>
          <InputRow>
            <Input
              ref={caret2.inputRef}
              variant="amount"
              pallete="purple"
              value={amount2.value}
              onChange={caret2.handleChange}
              onFocus={h2.onFocus}
              onBlur={h2.onBlur}
            />
            <AssetLabel title={t2} assets_id={data.aid2} />
          </InputRow>
        </AssetsSection>
      </SwapBlock>
      {footer}
    </SwapCard>
  ) : (
    <SwapCard>
      <SwapBlock>
        <BlockLabel>{t1}</BlockLabel>
        <AssetsSection>
          <InputRow>
            <Input
              ref={caret1.inputRef}
              variant="amount"
              pallete="blue"
              value={amount1.value}
              onChange={handleAmount1Change}
              onFocus={h1.onFocus}
              onBlur={h1.onBlur}
            />
            <AssetLabel title={t1} assets_id={data.aid1} />
          </InputRow>
        </AssetsSection>
      </SwapBlock>
      <SwapBlock>
        <BlockLabel>{t2}</BlockLabel>
        <AssetsSection>
          <InputRow>
            <Input
              ref={caret2.inputRef}
              variant="amount"
              pallete="purple"
              value={amount2.value}
              onChange={handleAmount2Change}
              onFocus={h2.onFocus}
              onBlur={h2.onBlur}
            />
            <AssetLabel title={t2} assets_id={data.aid2} />
          </InputRow>
        </AssetsSection>
      </SwapBlock>
      {footer}
    </SwapCard>
  );

  return (
    <Window hideHeader>
      <Container wide>
        <PageLayout>
          <BackNav onClick={() => navigate(ROUTES.POOLS.BASE)} />
          <MainCol>
            <PageSubTitle>Add Liquidity</PageSubTitle>
            <LiquidityFormWrap>{form}</LiquidityFormWrap>
          </MainCol>
        </PageLayout>
      </Container>
    </Window>
  );
};
