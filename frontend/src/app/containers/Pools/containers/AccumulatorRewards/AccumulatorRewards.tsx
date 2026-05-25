import React, { useEffect, useMemo, useState } from 'react';
import { styled } from '@linaria/react';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';

import {
  AssetsSection,
  Button,
  Container,
  Input,
  ReactSelect,
  Section,
  Window,
} from '@app/shared/components';
import AssetLabel from '@app/shared/components/AssetLabel';
import {
  BlockLabel,
  ButtonWrapper,
  EmbeddedTradeButtonWrap,
  ErrorHint,
  HintRow,
  InputRow,
  SwapBlock,
  SwapCard,
} from '@app/containers/Pools/containers/shared/poolFlowLayout';
import { useInput } from '@app/shared/hooks';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CancelIcon,
  IconFavoriteFilled,
} from '@app/shared/icons';
import { selectAssetsList, selectCurrentPool, selectRewards } from '@app/containers/Pools/store/selectors';
import * as mainActions from '@app/containers/Pools/store/actions';
import { IOptions } from '@core/types';
import { fromGroths, toGroths } from '@core/appUtils';
import { parseAmount } from '@app/containers/Pools/containers/shared/poolAmountInput';
import { BEAMX_ID, REWARDS_DEV_MODE, ROUTES } from '@app/shared/constants';
import { selectSystemState } from '@app/shared/store/selectors';
import { createInputErrorState } from '@app/containers/Pools/containers/shared/inputErrorState';
import connector from '@core/connector';
import AssetIcon from '@app/shared/components/AssetsIcon';
import { outlinedAssetSelectStyles } from '@app/shared/components/reactSelectStyles';

const purpleIn = { cursor: 'default' as const, color: 'var(--color-purple)', opacity: 1 };

const InfoRow = styled.div`
  display: flex;
  justify-content: space-between;
  font-size: 13px;
  color: rgba(255, 255, 255, 0.88);
  margin-top: 8px;
`;

const LocksTable = styled.table`
  width: 100%;
  margin-top: 14px;
  border-collapse: collapse;
  font-size: 11px;
`;

const TH = styled.th`
  text-align: left;
  color: rgba(255, 255, 255, 0.6);
  font-weight: 700;
  padding: 4px 4px;
  line-height: 1.2;
  font-size: 13px;
`;

const ActionsHeader = styled(TH)`
  text-align: right;
`;

const TD = styled.td`
  color: rgba(255, 255, 255, 0.9);
  padding: 4px 4px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  vertical-align: middle;
  line-height: 1.2;
  font-size: 13px;
`;

const ClaimableWrap = styled.div`
  display: inline-flex;
  align-items: center;
  white-space: nowrap;
`;

const ClaimableAmount = styled.span`
  margin-right: 8px;
`;

const ClaimableTicker = styled.span`
  color: rgba(255, 255, 255, 0.88);
  margin-left: -4px;
`;

const ActionsCell = styled(TD)`
  text-align: right;
`;

const InlineActions = styled.div`
  display: flex;
  align-items: center;
  justify-content: flex-end;
  width: 100%;

  > button {
    margin: 0 !important;
    font-size: 13px;
    line-height: 1.2;
  }

  > button:not(:last-child) {
    margin-right: 24px !important;
  }
`;

const LockSelectorWrap = styled.div`
  margin-top: 6px;
  min-height: 36px;
`;

const LocksPanel = styled.div`
  width: 100%;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.02);
  padding: 14px;
  margin-top: 14px;
`;

const DEFAULT_LOCK_OPTIONS = [
  { value: 1, label: '1 month' },
  { value: 3, label: '3 months' },
  { value: 6, label: '6 months' },
  { value: 12, label: '12 months' },
];

export const AccumulatorRewards = () => {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const currentPool = useSelector(selectCurrentPool());
  const assets = useSelector(selectAssetsList());
  const rewards = useSelector(selectRewards());
  const systemState = useSelector(selectSystemState());
  const forceRewardsPreview = REWARDS_DEV_MODE;
  const currentHeight = Number(systemState?.current_height || 0);
  const [previewHeight, setPreviewHeight] = useState<number>(currentHeight);
  const effectiveHeight = currentHeight > 0 ? currentHeight : previewHeight;
  const rewardsView = forceRewardsPreview
    ? {
      ...rewards,
      lpTokenBalance: 375000000,
      estimatedReward: 0,
      locks: effectiveHeight > 0 ? [
        {
          lpToken: 250000000,
          'avail-BeamX': 11000000,
          'unlock-height': effectiveHeight + 720,
        },
        {
          lpToken: 125000000,
          'avail-BeamX': 0,
          'unlock-height': effectiveHeight - 20,
        },
      ] : [],
    }
    : rewards;

  const lockOptions: IOptions[] = rewardsView.lockOptions.length ? rewardsView.lockOptions : DEFAULT_LOCK_OPTIONS;
  const [selectedLockOption, setSelectedLockOption] = useState<IOptions | null>(lockOptions[0] || null);
  const lockPeriod = selectedLockOption?.value || 0;
  const amountInput = useInput({
    initialValue: 0,
    validations: { isEmpty: true, isMax: fromGroths(rewardsView.lpTokenBalance || 0) },
  });
  const hasAmountToLock = toGroths(parseAmount(amountInput.value)) > 0;
  const amountError = createInputErrorState(
    hasAmountToLock && !rewardsView.isAvailable,
    'no rewards available',
  );

  const lpAsset = useMemo(
    () => assets.find((item) => item.aid === currentPool?.['lp-token']),
    [assets, currentPool],
  );
  const lpAssetTitle = lpAsset?.parsedMetadata?.UN || 'AMML';
  const lpAssetId = lpAsset?.aid || currentPool?.['lp-token'] || 0;

  useEffect(() => {
    if (!currentPool) return;
    dispatch(mainActions.loadAccumulatorRewards.request({ pool: currentPool }));
  }, [dispatch, currentPool]);

  useEffect(() => {
    if (!selectedLockOption && lockOptions[0]) {
      setSelectedLockOption(lockOptions[0]);
      return;
    }
    if (selectedLockOption && !lockOptions.some((item) => item.value === selectedLockOption.value)) {
      setSelectedLockOption(lockOptions[0] || null);
    }
  }, [lockOptions, selectedLockOption]);

  useEffect(() => {
    if (currentHeight > 0) {
      setPreviewHeight(currentHeight);
      return;
    }
    if (!forceRewardsPreview || previewHeight > 0) return;
    connector.callApi('wallet_status')
      .then((status: any) => {
        const walletHeight = Number(status?.current_height || 0);
        if (walletHeight > 0) {
          setPreviewHeight(walletHeight);
        }
      })
      .catch(() => {});
  }, [currentHeight, forceRewardsPreview, previewHeight]);

  useEffect(() => {
    if (!currentPool || !amountInput.value || !lockPeriod) {
      dispatch(mainActions.setRewardsState({ estimatedReward: 0 }));
      return;
    }

    const amountLpToken = toGroths(parseAmount(amountInput.value));
    if (!amountLpToken) {
      dispatch(mainActions.setRewardsState({ estimatedReward: 0 }));
      return;
    }

    dispatch(mainActions.predictAccumulatorRewards.request({ amountLpToken, lockPeriods: lockPeriod }));
  }, [dispatch, currentPool, amountInput.value, lockPeriod]);

  const onLock = () => {
    const amountLpToken = toGroths(parseAmount(amountInput.value));
    if (!amountLpToken || !lockPeriod) return;
    dispatch(mainActions.lockAccumulatorRewards.request({ amountLpToken, lockPeriods: lockPeriod }));
    amountInput.onPredict(0);
  };

  const onClaimRewards = (unlockHeight: number) => {
    dispatch(mainActions.updateAccumulatorRewards.request({
      withdrawBeamX: 1,
      withdrawLpToken: 0,
      hEnd: unlockHeight,
    }));
  };

  const onWithdrawLp = (unlockHeight: number) => {
    dispatch(mainActions.updateAccumulatorRewards.request({
      withdrawBeamX: 0,
      withdrawLpToken: 1,
      hEnd: unlockHeight,
    }));
  };

  if (!currentPool) {
    return (
      <Window title="accumulator rewards" backButton>
        <Container>
          <Section title="rewards">
            Select a pool from Trade first.
          </Section>
        </Container>
      </Window>
    );
  }

  return (
    <Window hideHeader>
      <Container wide>
        <SwapCard>
          <SwapBlock>
            <BlockLabel>Amount to lock</BlockLabel>
            <AssetsSection error={amountError.hasError}>
              <InputRow>
                <Input
                  value={amountInput.value}
                  variant="amount"
                  pallete="blue"
                  valid={!!amountInput.isValid && !amountError.hasError}
                  onChange={amountInput.onChange}
                  onFocus={() => {
                    if (amountInput.value === 0 || amountInput.value === '0') {
                      amountInput.onPredict('');
                    }
                  }}
                  onBlur={() => {
                    if (amountInput.value === '') {
                      amountInput.onPredict(0);
                    }
                  }}
                />
                <AssetLabel title={lpAssetTitle} assets_id={lpAssetId} />
              </InputRow>
            </AssetsSection>
            <HintRow>
              <span />
              {amountError.hasError && <ErrorHint>{amountError.message}</ErrorHint>}
            </HintRow>
          </SwapBlock>

          <SwapBlock>
            <BlockLabel>Lock period</BlockLabel>
            <LockSelectorWrap>
              <ReactSelect
                options={lockOptions}
                value={selectedLockOption}
                onChange={(next) => setSelectedLockOption(next as IOptions)}
                customPrefix="custom-asset-select"
                isClearable={false}
                styles={outlinedAssetSelectStyles}
              />
            </LockSelectorWrap>
          </SwapBlock>

          <SwapBlock>
            <BlockLabel>Rewards estimate</BlockLabel>
            <AssetsSection>
              <InputRow>
                <Input
                  disabled
                  pallete="purple"
                  variant="amount"
                  style={purpleIn}
                  value={hasAmountToLock ? fromGroths(rewardsView.estimatedReward || 0) : 0}
                />
                <AssetLabel title="BeamX" assets_id={BEAMX_ID} />
              </InputRow>
            </AssetsSection>
          </SwapBlock>

          <EmbeddedTradeButtonWrap>
            <ButtonWrapper>
              <Button icon={CancelIcon} variant="cancel" onClick={() => navigate(ROUTES.POOLS.BASE)}>
                Cancel
              </Button>
              <Button
                icon={ArrowDownIcon}
                variant="withdraw"
                onClick={onLock}
                disabled={!rewardsView.isAvailable || !amountInput.isValid || !amountInput.value || rewardsView.isLoading}
              >
                Lock
              </Button>
            </ButtonWrapper>
          </EmbeddedTradeButtonWrap>
        </SwapCard>
        <LocksPanel>
          <BlockLabel>Balance overview</BlockLabel>
          <InfoRow>
            <span>LP token balance</span>
            <span>{fromGroths(rewardsView.lpTokenBalance || 0)}</span>
          </InfoRow>
          <InfoRow>
            <span>Active locks</span>
            <span>{rewardsView.locks.length}</span>
          </InfoRow>
          {rewardsView.locks.length > 0 && (
            <LocksTable>
              <thead>
                <tr>
                  <TH>Claimable</TH>
                  <TH>Locked LP</TH>
                  <TH>Unlock Height</TH>
                  <ActionsHeader>Actions</ActionsHeader>
                </tr>
              </thead>
              <tbody>
                {rewardsView.locks.map((lock, idx) => {
                  const unlockHeightRaw = lock['unlock-height'];
                  const unlockHeight = Number(unlockHeightRaw || 0);
                  const claimableBeamX = Number(lock['avail-BeamX'] || 0);
                  const lockedLp = Number(lock.lpToken || 0);
                  const canWithdraw = unlockHeight > 0 && currentHeight >= unlockHeight;
                  return (
                    <tr key={`${unlockHeight}-${idx}`}>
                      <TD>
                        <ClaimableWrap>
                          <ClaimableAmount>{fromGroths(claimableBeamX)}</ClaimableAmount>
                          <AssetIcon asset_id={BEAMX_ID} />
                          <ClaimableTicker>BEAMX</ClaimableTicker>
                        </ClaimableWrap>
                      </TD>
                      <TD>{fromGroths(lockedLp)}</TD>
                      <TD>{unlockHeightRaw ?? '-'}</TD>
                      <ActionsCell>
                        <InlineActions>
                          <Button
                            icon={IconFavoriteFilled}
                            variant="link"
                            onClick={() => onClaimRewards(unlockHeight)}
                            disabled={!claimableBeamX}
                          >
                            CLAIM
                          </Button>
                          <Button
                            icon={ArrowUpIcon}
                            variant="link"
                            pallete="purple"
                            onClick={() => onWithdrawLp(unlockHeight)}
                            disabled={!lockedLp || !canWithdraw}
                          >
                            WITHDRAW
                          </Button>
                        </InlineActions>
                      </ActionsCell>
                    </tr>
                  );
                })}
              </tbody>
            </LocksTable>
          )}
        </LocksPanel>
      </Container>
    </Window>
  );
};
