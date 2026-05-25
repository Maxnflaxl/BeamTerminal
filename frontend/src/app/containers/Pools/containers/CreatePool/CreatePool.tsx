import React, { useEffect, useState } from 'react';
import './index.scss';
import {
  Button, Window, Container, ReactSelect,
} from '@app/shared/components';
import { AssetSelectorButton } from '@app/shared/components/AssetSearchModal';
import { useDispatch } from 'react-redux';
import { ICreatePool, IOptions, Kind } from '@core/types';
import {
  kindSelect, placeHolder, ROUTES, titleSections,
} from '@app/shared/constants';
import * as mainActions from '@app/containers/Pools/store/actions';
import { CancelIcon, DoneIcon } from '@app/shared/icons';
import BackNav, { PageLayout, MainCol } from '@app/shared/components/BackNav';
import { useNavigate } from 'react-router-dom';
import {
  BlockLabel,
  ButtonBlock,
  ButtonWrapper,
  EmbeddedTradeButtonWrap,
  SelectWrapper,
  SwapBlock,
  SwapCard,
} from '@app/containers/Pools/containers/shared/poolFlowLayout';
import { styled } from '@linaria/react';

const FeeField = styled.div`
  max-width: 167px;
`;

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

export const CreatePool = () => {
  const [requestData, setRequestData] = useState(null);
  const [currentToken1, setCurrentToken1] = useState<IOptions>(null);
  const [currentToken2, setCurrentToken2] = useState<IOptions>(null);
  const [openSlot, setOpenSlot] = useState<null | 1 | 2>(null);
  const [currentKind, setCurrentKind] = useState<IOptions>({ value: Kind.High, label: '1%' });
  const [isValidate, setIsValidate] = useState(false);
  const navigate = useNavigate();
  const dispatch = useDispatch();

  useEffect(() => {
    setRequestData([
      {
        aid1: currentToken1 && currentToken1.value,
        aid2: currentToken2 && currentToken2.value,
        kind: currentKind && currentKind.value,
      },
    ]);
  }, [currentToken1, currentToken2, currentKind]);

  useEffect(() => {
    if (currentToken1 === null || currentToken2 === null || currentKind === null) {
      setIsValidate(false);
    } else {
      setIsValidate(true);
    }
  }, [currentToken1, currentToken2, currentKind]);

  const onPreviousClick = () => {
    navigate(ROUTES.POOLS.BASE);
  };

  const createPool = (dataReq: ICreatePool[]) => {
    dispatch(mainActions.onCreatePool.request(dataReq));
  };

  return (
    <Window hideHeader>
      <Container wide>
        <PageLayout>
          <BackNav onClick={onPreviousClick} />
          <MainCol>
            <PageSubTitle>Create Pool</PageSubTitle>
            <LiquidityFormWrap>
              <SwapCard>
                <SelectWrapper>
                  <SwapBlock>
                    <BlockLabel>{titleSections.CREATE_FIRST}</BlockLabel>
                    <AssetSelectorButton
                      value={currentToken1}
                      onSelect={(opt) => setCurrentToken1(opt)}
                      excludeAssetId={currentToken2?.value ?? null}
                      placeholder={placeHolder.ASSETS}
                      isOpen={openSlot === 1}
                      onOpen={() => setOpenSlot(1)}
                      onClose={() => setOpenSlot(null)}
                    />
                  </SwapBlock>
                  <SwapBlock>
                    <BlockLabel>{titleSections.CREATE_SECOND}</BlockLabel>
                    <AssetSelectorButton
                      value={currentToken2}
                      onSelect={(opt) => setCurrentToken2(opt)}
                      excludeAssetId={currentToken1?.value ?? null}
                      placeholder={placeHolder.ASSETS}
                      isOpen={openSlot === 2}
                      onOpen={() => setOpenSlot(2)}
                      onClose={() => setOpenSlot(null)}
                    />
                  </SwapBlock>
                </SelectWrapper>
                <SwapBlock>
                  <BlockLabel>{titleSections.FEE}</BlockLabel>
                  <FeeField>
                    <ReactSelect
                      options={kindSelect}
                      onChange={(e) => setCurrentKind(e)}
                      value={currentKind}
                      placeholder={placeHolder.FEE}
                      customPrefix="custom-kind"
                      isSearchable={false}
                      isClearable={false}
                    />
                  </FeeField>
                </SwapBlock>
                <EmbeddedTradeButtonWrap>
                  <ButtonBlock>
                    <ButtonWrapper>
                      <Button icon={CancelIcon} variant="cancel" onClick={onPreviousClick}>
                        Cancel
                      </Button>
                      <Button
                        icon={DoneIcon}
                        variant="approve"
                        onClick={() => createPool(requestData)}
                        disabled={!isValidate}
                      >
                        Create Pool
                      </Button>
                    </ButtonWrapper>
                  </ButtonBlock>
                </EmbeddedTradeButtonWrap>
              </SwapCard>
            </LiquidityFormWrap>
          </MainCol>
        </PageLayout>
      </Container>
    </Window>
  );
};
