import React, { useEffect, useState } from 'react';
import { styled } from '@linaria/react';
import {
  fromGroths, setDataRequest, toGroths, truncate,
} from '@core/appUtils';
import {
  AssetsSection, Button, Container, Input, Window,
} from '@app/shared/components';
import { useInput } from '@app/shared/hooks';
import * as mainActions from '@app/containers/Pools/store/actions';
import { useDispatch, useSelector } from 'react-redux';
import { selectAssetsList, selectCurrentPool, selectPredirect } from '@app/containers/Pools/store/selectors';
import { ROUTES } from '@app/shared/constants';
import AssetLabel from '@app/shared/components/AssetLabel';
import { ArrowDownIcon, CancelIcon } from '@app/shared/icons';
import BackNav, { PageLayout, MainCol } from '@app/shared/components/BackNav';
import { useNavigate } from 'react-router-dom';
import { toast } from 'react-toastify';
import {
  BlockLabel, ButtonWrapper, EmbeddedTradeButtonWrap, InputRow, SwapBlock, SwapCard,
} from '@app/containers/Pools/containers/shared/poolFlowLayout';
import {
  createAmountFieldHandlers, formatPredictedFieldDisplay, parseAmount, useAmountInputCaret,
} from '@app/containers/Pools/containers/shared/poolAmountInput';

const PageSubTitle = styled.h4`
  margin: 0 0 12px 0;
  font-size: 14px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 3px;
  color: rgba(255, 255, 255, 0.5);
`;

const LiquidityFormWrap = styled.div`
  width: 100%;
  max-width: 620px;
  min-width: 0;
  overflow-x: hidden;
  margin-top: var(--pool-embedded-layout-margin-top);
`;

const purpleIn = { cursor: 'default' as const, color: 'var(--color-purple)', opacity: 1 };
const actionsRow = {
  display: 'flex', justifyContent: 'center', width: '100%', marginTop: 24,
} as const;

export const WithdrawPool = () => {
  const data = useSelector(selectCurrentPool());
  const assets = useSelector(selectAssetsList());
  const predictData = useSelector(selectPredirect());
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const [lp, setLp] = useState(null);
  const [maxCtl, setMaxCtl] = useState(data.ctl);
  const amt = useInput({ initialValue: 0, validations: { isEmpty: true, isMax: fromGroths(maxCtl) } });
  const caret = useAmountInputCaret(amt.value, amt.onPredict);
  const [req, setReq] = useState(null);
  const n1 = truncate(data?.metadata1?.UN || `Token ${data?.aid1 ?? ''}`);
  const n2 = truncate(data?.metadata2?.UN || `Token ${data?.aid2 ?? ''}`);
  const lpLabel = lp?.parsedMetadata?.UN ? truncate(lp.parsedMetadata.UN) : 'AMML';
  const lpAid = lp?.aid ?? data['lp-token'];
  const h = createAmountFieldHandlers(predictData, amt, amt.value);

  useEffect(() => { if (data && assets) setLp(assets.find((x) => x.aid === data['lp-token'])); }, [data, assets]);
  useEffect(() => {
    setReq({
      aid1: data.aid1, aid2: data.aid2, kind: data.kind, ctl: toGroths(parseAmount(amt.value)),
    });
  }, [amt.value, data.aid1, data.aid2, data.kind]);
  useEffect(() => setMaxCtl(data.ctl), [data.ctl]);
  useEffect(() => {
    if (amt.isMax) toast('Amount assets > MAX', { toastId: 'amount-max-withdraw' });
    else if (amt.isValid) dispatch(mainActions.onWithdraw.request(req));
  }, [req, amt.value, amt.isValid, amt.isMax, dispatch]);

  const receive = [
    { field: 'tok1' as const, name: n1, aid: data.aid1 },
    { field: 'tok2' as const, name: n2, aid: data.aid2 },
  ];

  return (
    <Window hideHeader>
      <Container wide>
        <PageLayout>
          <BackNav onClick={() => navigate(ROUTES.POOLS.BASE)} />
          <MainCol>
            <PageSubTitle>Remove Liquidity</PageSubTitle>
            <LiquidityFormWrap>
              <SwapCard>
                <SwapBlock>
                  <BlockLabel>Withdraw LP</BlockLabel>
                  <AssetsSection>
                    <InputRow>
                      <Input
                        ref={caret.inputRef}
                        value={amt.value}
                        variant="amount"
                        pallete="blue"
                        onChange={caret.handleChange}
                        onFocus={h.onFocus}
                        onBlur={h.onBlur}
                      />
                      <AssetLabel title={lpLabel} assets_id={lpAid} />
                    </InputRow>
                  </AssetsSection>
                </SwapBlock>
                <SwapBlock>
                  <BlockLabel>You receive</BlockLabel>
                  {receive.map((r) => (
                    <AssetsSection key={r.field}>
                      <InputRow>
                        <Input
                          disabled
                          pallete="purple"
                          variant="amount"
                          style={purpleIn}
                          value={formatPredictedFieldDisplay(predictData, amt.value, r.field)}
                        />
                        <AssetLabel title={r.name} assets_id={r.aid} />
                      </InputRow>
                    </AssetsSection>
                  ))}
                </SwapBlock>
                <EmbeddedTradeButtonWrap>
                  <div style={actionsRow}>
                    <ButtonWrapper>
                      <Button icon={CancelIcon} variant="cancel" onClick={() => navigate(ROUTES.POOLS.BASE)}>Cancel</Button>
                      <Button
                        disabled={!amt.isValid}
                        icon={ArrowDownIcon}
                        variant="withdraw"
                        onClick={() => dispatch(mainActions.onWithdraw.request(setDataRequest(req)))}
                      >
                        Withdraw
                      </Button>
                    </ButtonWrapper>
                  </div>
                </EmbeddedTradeButtonWrap>
              </SwapCard>
            </LiquidityFormWrap>
          </MainCol>
        </PageLayout>
      </Container>
    </Window>
  );
};
