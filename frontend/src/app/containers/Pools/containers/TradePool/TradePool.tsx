import React, {
  useCallback, useEffect, useMemo, useState,
} from 'react';
import { createPortal } from 'react-dom';
import { IOptions, ITrade, IPoolCard } from '@core/types';
import {
  emptyPredict, formatNumber, fromGroths, getPoolKind, setDataRequest, toGroths, truncate,
} from '@core/appUtils';
import { styled } from '@linaria/react';
import {
  AssetsContainer,
  AssetsSection,
  Button,
  Container,
  Input,
  PoolStat,
  Section,
  Window,
} from '@app/shared/components';
import { AssetSelectorButton } from '@app/shared/components/AssetSearchModal';
import { useInput, useDebounce } from '@app/shared/hooks';
import BeamDappConnector from '@core/BeamDappConnector.js';
import * as mainActions from '@app/containers/Pools/store/actions';
import { useDispatch, useSelector } from 'react-redux';
import './index.scss';
import {
  selectAssetsList,
  selectCurrentPool,
  selectOptions,
  selectPredirect,
  selectPoolsList,
  selectRewards,
} from '@app/containers/Pools/store/selectors';
import {
  CancelIcon, DoneIcon, IconExchange, IconReceive, IconShieldChecked,
} from '@app/shared/icons';
import {
  BEAM_ID, BEAMX_ID, REWARDS_DEV_MODE, ROUTES, titleSections,
  getRealAssetIdForFake, isImposterAsset, poolHasRewards,
} from '@app/shared/constants';
import AssetIcon from '@app/shared/components/AssetsIcon';
import AssetLabel, {
  Amount, AssetsId, PredictTitleStyled,
} from '@app/shared/components/AssetLabel';
import { useNavigate } from 'react-router-dom';
import {
  AssetAmount,
  BlockLabel,
  ButtonBlock,
  ButtonWrapper,
  EmbeddedActionRow,
  EmbeddedExchangeWrap,
  EmbeddedLayout,
  EmbeddedSwapColumn,
  EmbeddedRightStack,
  EmbeddedTradeSummaryBelowPool,
  EmbeddedTradeButtonWrap,
  EmptyPoolState,
  ErrorHint,
  ExchangeWrapper,
  HintRow,
  InlineSelect,
  InputRow,
  Line,
  RateText,
  RightPanel,
  SearchHint,
  SectionWrapper,
  SelectWrapper,
  SummaryAsset,
  SummaryContainer,
  SummaryHeader,
  SummaryPanel,
  SummaryTitle,
  SummaryWrapper,
  TradeSummaryIconInner,
  TradeSummaryTable,
  TradeSummaryTdIcon,
  TradeSummaryTdLabel,
  TradeSummaryTdValue,
  TradeSummaryTitleInGrid,
  TradeSummaryNameId,
  TradeSummaryValueInner,
  SwapBlock,
  SwapCard,
  TotalTitle,
} from '@app/containers/Pools/containers/shared/poolFlowLayout';
import {
  createAmountFieldHandlers,
  formatPredictAmount,
  parseAmount,
  useAmountInputCaret,
} from '@app/containers/Pools/containers/shared/poolAmountInput';

const receiveAmountInputStyle = { cursor: 'default', color: 'var(--color-purple)', opacity: 1 } as const;

const RateSwitcherWrap = styled.div`
  display: flex;
  width: 18px;
  height: 18px;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  margin-right: 0;

  button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    margin: 0 !important;
    padding: 0;
    line-height: 0;
    vertical-align: unset;

    > svg {
      display: block;
      width: 18px;
      height: 18px;
      vertical-align: unset;
    }
  }
`;

/** Mirrors Totals::Trade + FeeSettings::Get from amm/contract.h exactly. */
function tradeForward(
  tok1: bigint, tok2: bigint, kind: number, vBuy1: bigint,
): { buy: bigint; totalPay: bigint } | null {
  if (vBuy1 <= 0n || vBuy1 >= tok1 || tok2 <= 0n) return null;
  const rawPay = tok1 * tok2 / (tok1 - vBuy1) - tok2;
  let fee: bigint;
  switch (kind) {
    case 0: fee = rawPay / 2000n; break;
    case 1: fee = rawPay / 1000n * 3n; break;
    default: fee = rawPay / 100n; break;
  }
  fee += 1n;
  return { buy: vBuy1, totalPay: rawPay + fee };
}

/** Given total pay, binary-search for buy amount (mirrors app.cpp pool_trade). */
function tradeReverse(
  tok1: bigint, tok2: bigint, kind: number, totalPay: bigint,
): { buy: bigint; totalPay: bigint } | null {
  if (totalPay <= 0n || tok1 <= 1n || tok2 <= 0n) return null;
  let rawEst: bigint;
  switch (kind) {
    case 0: rawEst = totalPay * 2000n / 2001n; break;
    case 1: rawEst = totalPay * 1000n / 1003n; break;
    default: rawEst = totalPay * 100n / 101n; break;
  }
  const denom = tok2 + rawEst;
  if (denom <= 0n) return null;
  let guess = tok1 - tok1 * tok2 / denom;
  if (guess <= 0n) guess = 1n;
  if (guess >= tok1) guess = tok1 - 1n;

  let lo = guess > 10000n ? guess - guess / 10000n - 1n : 0n;
  let hi = guess + guess / 1000n + 1n;
  if (hi >= tok1) hi = tok1 - 1n;

  let best: { buy: bigint; totalPay: bigint } | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) / 2n;
    const r = tradeForward(tok1, tok2, kind, mid);
    if (!r) { hi = mid - 1n; continue; }
    if (r.totalPay <= totalPay) { best = r; lo = mid + 1n; } else { hi = mid - 1n; }
  }
  return best;
}

const FeeTierRow = styled.div`
  display: flex;
  align-items: center;
  margin-top: 12px;
  flex-wrap: wrap;
`;

const FeeTierButton = styled.button<{ active: boolean }>`
  display: flex;
  align-items: center;
  padding: 4px 12px;
  margin-right: 8px;
  border-radius: 20px;
  border: 1px solid ${({ active }) => (active ? 'var(--color-purple)' : 'rgba(255,255,255,0.15)')};
  background: ${({ active }) => (active ? 'rgba(162,98,247,0.15)' : 'transparent')};
  color: ${({ active }) => (active ? 'var(--color-purple)' : 'rgba(255,255,255,0.5)')};
  font-size: 13px;
  cursor: pointer;
`;

const BestBadge = styled.span`
  font-size: 10px;
  font-weight: 700;
  color: #00e2c2;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  margin-left: 4px;
`;

const AutoButton = styled.button`
  padding: 4px 10px;
  border-radius: 20px;
  border: 1px solid rgba(255,255,255,0.15);
  background: transparent;
  color: rgba(255,255,255,0.4);
  font-size: 12px;
  cursor: pointer;
`;

const WarningModalBackdrop = styled.div`
  position: fixed;
  inset: 0;
  z-index: 20000;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
`;

const WarningModalPanel = styled.div`
  width: 460px;
  max-width: calc(100vw - 24px);
  background: var(--color-dark-blue);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 16px;
  padding: 18px;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
`;

const WarningTitle = styled.div`
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 1px;
  text-transform: uppercase;
  color: #ff5f5f;
  margin-bottom: 10px;
`;

const WarningText = styled.p`
  margin: 0;
  color: rgba(255, 255, 255, 0.88);
  font-size: 14px;
  line-height: 1.5;
`;

const WarningList = styled.ul`
  margin: 12px 0;
  padding-left: 18px;
  color: rgba(255, 255, 255, 0.88);
  font-size: 13px;
`;

const WarningActions = styled.div`
  margin-top: 16px;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
`;

interface TradePoolProps {
  embedded?: boolean;
}

type SelectionSide = 'from' | 'to';

interface AssetSelectionWarningState {
  side: SelectionSide;
  selectedOption: IOptions;
  realAssetId: number;
}

export const TradePool = ({ embedded = false }: TradePoolProps) => {
  const data = useSelector(selectCurrentPool());
  const assets = useSelector(selectAssetsList());
  const pools = useSelector(selectPoolsList());
  const options = useSelector(selectOptions());
  const predictData = useSelector(selectPredirect());
  const rewards = useSelector(selectRewards());
  const [currentToken, setCurrentToken] = useState<number | null>(data?.aid1 ?? null);
  const [secondToken, setSecondToken] = useState<number | null>(data?.aid2 ?? null);
  const [currentLPToken, setCurrentLPToken] = useState(null);
  const [manualKind, setManualKind] = useState<number | null>(null);
  const [bestKind, setBestKind] = useState<number | null>(null);
  const [currentTokAmount, setCurrentTokenAmount] = useState<number>(data?.tok1 ?? 0);
  const [secondTokAmount, setSecondTokenAmount] = useState<number>(data?.tok2 ?? 0);
  const amountInput = useInput({
    initialValue: 0,
    validations: { isEmpty: true, isMax: Number.MAX_SAFE_INTEGER },
  });
  const amountSendInput = useInput({
    initialValue: 0,
    validations: { isEmpty: true, isMax: fromGroths(secondTokAmount) },
  });
  const [requestData, setRequestData] = useState(null);
  const debouncedRequestData = useDebounce(requestData, 300);
  const walletRequestData = BeamDappConnector.isDesktop() ? requestData : debouncedRequestData;
  const [lastChangedInput, setLastChangedInput] = useState<number>(1);
  const [flipRate, setFlipRate] = useState(false);
  const [fromSelectorOpen, setFromSelectorOpen] = useState(false);
  const [toSelectorOpen, setToSelectorOpen] = useState(false);
  const [selectionWarning, setSelectionWarning] = useState<AssetSelectionWarningState | null>(null);
  const [pendingSelectionWarning, setPendingSelectionWarning] = useState<AssetSelectionWarningState | null>(null);
  const [tradeWarningOpen, setTradeWarningOpen] = useState(false);
  const [pendingTradeData, setPendingTradeData] = useState<ITrade | null>(null);
  const isDesktopClient = BeamDappConnector.isDesktop();
  const dispatch = useDispatch();
  const navigate = useNavigate();

  const { inputRef: amountInputRef, handleChange: handleAmountInputChange } = useAmountInputCaret(
    amountInput.value,
    amountInput.onPredict,
    1,
    setLastChangedInput,
  );
  const { inputRef: amountSendInputRef, handleChange: handleAmountSendInputChange } = useAmountInputCaret(
    amountSendInput.value,
    amountSendInput.onPredict,
    2,
    setLastChangedInput,
  );

  const toPoolPartnerIds = useMemo(() => {
    if (currentToken === null) return new Set<number>();
    const partnerIds = (pools || []).flatMap((p) => {
      if (p.aid1 === currentToken) return [p.aid2];
      if (p.aid2 === currentToken) return [p.aid1];
      return [];
    });
    return new Set(partnerIds);
  }, [pools, currentToken]);

  const matchedPools = useMemo<IPoolCard[]>(() => {
    if (currentToken === null || secondToken === null) return [];
    return pools
      .filter((pool) => (
        (pool.aid1 === currentToken && pool.aid2 === secondToken)
        || (pool.aid1 === secondToken && pool.aid2 === currentToken)
      ))
      .sort((a, b) => b.ctl - a.ctl);
  }, [pools, currentToken, secondToken]);

  const activePool = useMemo<IPoolCard | null>(() => {
    if (!matchedPools.length) return null;
    if (manualKind !== null) {
      return matchedPools.find((p) => p.kind === manualKind) || matchedPools[0];
    }
    const dataIsCurrentPair = data && matchedPools.some(
      (p) => p.aid1 === data.aid1 && p.aid2 === data.aid2 && p.kind === data.kind,
    );
    if (dataIsCurrentPair) {
      return data;
    }
    return matchedPools[0];
  }, [matchedPools, data, manualKind]);

  const [, anyPoolCoversToAmount] = useMemo<[boolean, boolean]>(() => {
    if (manualKind !== null || matchedPools.length <= 1) return [false, false];
    const checkCovers = (amountValue: string | number, fromToken: boolean) => {
      const parsed = parseAmount(amountValue);
      if (!parsed || parsed <= 0) return false;
      return matchedPools.some((pool) => {
        const reserve = fromGroths(fromToken
          ? (currentToken === pool.aid1 ? pool.tok1 : pool.tok2)
          : (currentToken === pool.aid1 ? pool.tok2 : pool.tok1));
        return parsed < Number(reserve);
      });
    };
    return [
      checkCovers(amountInput.value, true),
      checkCovers(amountSendInput.value, false),
    ];
  }, [manualKind, matchedPools, currentToken, amountInput.value, amountSendInput.value]);

  const getTokenTitle = (assetId: number | null) => {
    const option = options.find((item) => item.value === assetId);
    return truncate(option?.label || 'Asset');
  };

  const tokenName_1 = getTokenTitle(currentToken);
  const tokenName_2 = getTokenTitle(secondToken);

  function swapTokensAndResetSend() {
    setCurrentToken(secondToken);
    setSecondToken(currentToken);
    setLastChangedInput(1);
    amountSendInput.onPredict(0);
  }

  useEffect(() => {
    if (!embedded) {
      if (currentToken === null || secondToken === null) {
        const pool = pools[0];
        if (pool) {
          setCurrentToken(pool.aid1);
          setSecondToken(pool.aid2);
        }
      }
      return;
    }
    if (currentToken === null || secondToken === null) {
      const hasBeam = options.some((item) => item.value === BEAM_ID);
      const hasBeamX = options.some((item) => item.value === BEAMX_ID);
      if (hasBeam && hasBeamX) {
        setCurrentToken(BEAM_ID);
        setSecondToken(BEAMX_ID);
      } else if (pools[0]) {
        setCurrentToken(pools[0].aid1);
        setSecondToken(pools[0].aid2);
      }
    }
  }, [embedded, pools, options, currentToken, secondToken]);

  useEffect(() => {
    if (currentToken === null || secondToken === null) return;
    if (!toPoolPartnerIds.has(secondToken)) {
      const first = toPoolPartnerIds.values().next().value;
      if (first !== undefined) setSecondToken(first);
    }
  }, [currentToken, secondToken, toPoolPartnerIds]);

  useEffect(() => {
    if (!embedded && data?.aid1 && data?.aid2) {
      setCurrentToken(data.aid1);
      setSecondToken(data.aid2);
    }
  }, [embedded, data?.aid1, data?.aid2]);

  useEffect(() => {
    setManualKind(null);
    setBestKind(null);
  }, [currentToken, secondToken]);

  useEffect(() => {
    if (!activePool || currentToken === null) {
      setCurrentTokenAmount(0);
      setSecondTokenAmount(0);
      return;
    }
    setCurrentTokenAmount(currentToken === activePool.aid1 ? activePool.tok1 : activePool.tok2);
    setSecondTokenAmount(currentToken === activePool.aid1 ? activePool.tok2 : activePool.tok1);
  }, [activePool, currentToken]);

  useEffect(() => {
    if (
      activePool
      && (!data || data.aid1 !== activePool.aid1 || data.aid2 !== activePool.aid2 || data.kind !== activePool.kind)
    ) {
      dispatch(mainActions.setCurrentPool(activePool));
    }
  }, [activePool, data, dispatch]);

  useEffect(() => {
    if (lastChangedInput !== 1) return;
    const payGroths = toGroths(parseAmount(amountInput.value));
    setRequestData({
      aid1: secondToken,
      aid2: currentToken,
      kind: activePool?.kind ?? 0,
      val2_pay: payGroths,
    });
    try {
      if (payGroths > 0 && secondTokAmount > 0 && currentTokAmount > 0) {
        const r = tradeReverse(
          BigInt(Math.round(secondTokAmount)), BigInt(Math.round(currentTokAmount)),
          activePool?.kind ?? 0, BigInt(Math.round(payGroths)),
        );
        if (r) amountSendInput.onPredict(formatPredictAmount(fromGroths(Number(r.buy))));
      }
    } catch (_) { /* wallet prediction will correct */ }
    // manualKind instead of activePool?.kind: re-trigger on user fee-tier
    // selection but NOT when findBestPool auto-switches the pool (cascade).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amountInput.value, currentToken, secondToken, lastChangedInput, manualKind]);

  useEffect(() => {
    if (lastChangedInput !== 2) return;
    const buyGroths = toGroths(parseAmount(amountSendInput.value));
    setRequestData({
      aid1: secondToken,
      aid2: currentToken,
      kind: activePool?.kind ?? 0,
      val1_buy: buyGroths,
    });
    try {
      if (buyGroths > 0 && secondTokAmount > 0 && currentTokAmount > 0) {
        const r = tradeForward(
          BigInt(Math.round(secondTokAmount)), BigInt(Math.round(currentTokAmount)),
          activePool?.kind ?? 0, BigInt(Math.round(buyGroths)),
        );
        if (r) amountInput.onPredict(formatPredictAmount(fromGroths(Number(r.totalPay))));
      }
    } catch (_) { /* wallet prediction will correct */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amountSendInput.value, currentToken, secondToken, lastChangedInput, manualKind]);

  const hasActivePool = !!activePool;
  const hasRewardsPool = poolHasRewards(activePool?.['lp-token'] || activePool?.lp_token);
  const hasRemainingRewardsBalance = rewards.lpTokenBalance > 0
    || rewards.locks.some((lock) => Number(lock.lpToken || 0) > 0 || Number(lock['avail-BeamX'] || 0) > 0);
  const showRewardsButton = REWARDS_DEV_MODE
    ? true
    : (hasActivePool && hasRewardsPool && rewards.isAvailable && hasRemainingRewardsBalance);

  useEffect(() => {
    dispatch(mainActions.loadAccumulatorRewards.request({ pool: activePool || null }));
  }, [dispatch, activePool]);

  useEffect(() => {
    if (!walletRequestData || !hasActivePool || lastChangedInput !== 1) return;
    const willFindBest = !manualKind && matchedPools.length > 1;
    const val2Pay = walletRequestData.val2_pay ?? 0;
    if (willFindBest) {
      if (val2Pay > 0) {
        dispatch(mainActions.onFindBestPool.request({
          pools: matchedPools,
          aid1: secondToken,
          aid2: currentToken,
          val2_pay: val2Pay,
          val1_buy: 0,
        }));
      }
      return;
    }
    if (amountInput.isMax || !amountInput.isValid) return;
    dispatch(mainActions.onPredictTrade.request(walletRequestData));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletRequestData, lastChangedInput, amountInput.isMax, amountInput.isValid,
    hasActivePool, dispatch]);
  useEffect(() => {
    if (!walletRequestData || !hasActivePool || lastChangedInput !== 2) return;
    const willFindBest = !manualKind && matchedPools.length > 1;
    const val1Buy = walletRequestData.val1_buy ?? 0;
    if (willFindBest) {
      if (val1Buy > 0) {
        dispatch(mainActions.onFindBestPool.request({
          pools: matchedPools,
          aid1: secondToken,
          aid2: currentToken,
          val2_pay: 0,
          val1_buy: val1Buy,
        }));
      }
      return;
    }
    if (amountSendInput.isMax || !amountSendInput.isValid) return;
    dispatch(mainActions.onPredictTrade.request(walletRequestData));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletRequestData, lastChangedInput, amountSendInput.isMax, amountSendInput.isValid,
    hasActivePool, dispatch]);

  useEffect(() => {
    if (activePool && assets) {
      setCurrentLPToken(assets.find((el) => el.aid === activePool['lp-token']));
    }
  }, [activePool, assets]);

  const onTrade = useCallback((dataTrade: ITrade) => {
    dispatch(mainActions.onTradePool.request(setDataRequest(dataTrade)));
  }, [dispatch]);

  const onPreviousClick = () => {
    navigate(ROUTES.POOLS.BASE);
  };

  const isTradeDisabled = !activePool || (!amountInput.isValid && !amountSendInput.isValid);

  // Paying FROM is not constrained by FROM-side reserve; reserve-limit checks apply to desired TO amount.
  const fromAmountError = false;
  const toAmountError = Boolean(amountSendInput.isMax && lastChangedInput === 2 && !anyPoolCoversToAmount);

  const selectValue = (assetId: number | null): IOptions | null => (
    options.find((item) => item.value === assetId) || null
  );
  const optionById = useCallback((assetId: number): IOptions => (
    options.find((item) => item.value === assetId) || { value: assetId, label: `Asset ${assetId}` }
  ), [options]);
  const selectedImposterWarnings = useMemo(() => {
    const warnings: Array<{ fakeAssetId: number; realAssetId: number }> = [];
    [currentToken, secondToken].forEach((assetId) => {
      const realAssetId = getRealAssetIdForFake(assetId);
      if (assetId !== null && realAssetId !== null) {
        warnings.push({ fakeAssetId: assetId, realAssetId });
      }
    });
    return warnings;
  }, [currentToken, secondToken]);
  const hasSelectedImposterAssets = selectedImposterWarnings.length > 0;
  const fromReserve = activePool
    ? (currentToken === activePool.aid1 ? fromGroths(activePool.tok1) : fromGroths(activePool.tok2))
    : 0;
  const toReserve = activePool
    ? (currentToken === activePool.aid1 ? fromGroths(activePool.tok2) : fromGroths(activePool.tok1))
    : 0;
  const poolRate = Number(fromReserve) > 0 ? Number(toReserve) / Number(fromReserve) : 0;
  const effectivePayRaw = predictData?.pay ?? predictData?.pay_raw ?? predictData?.tok2 ?? 0;
  const effectiveBuyRaw = predictData?.buy ?? predictData?.tok1 ?? 0;
  const execPay = Number(fromGroths(effectivePayRaw));
  const execBuy = Number(fromGroths(effectiveBuyRaw));
  const feeDao = Number(predictData?.fee_dao || 0);
  const feePool = Number(predictData?.fee_pool || 0);
  const feeTotal = feeDao + feePool;
  const executionRate = execPay > 0 ? execBuy / execPay : 0;
  const priceImpact = poolRate > 0 && executionRate > 0 ? ((poolRate - executionRate) / poolRate) * 100 : 0;
  const activeAmount = lastChangedInput === 1 ? parseAmount(amountInput.value) : parseAmount(amountSendInput.value);
  const hasActiveQuoteInput = Number.isFinite(activeAmount) && activeAmount > 0;
  const displayedBuyRaw = hasActiveQuoteInput ? effectiveBuyRaw : 0;
  const displayedPayRaw = hasActiveQuoteInput ? effectivePayRaw : 0;
  const displayedFeeDao = hasActiveQuoteInput ? feeDao : 0;
  const displayedFeePool = hasActiveQuoteInput ? feePool : 0;
  const displayedFeeTotal = hasActiveQuoteInput ? feeTotal : 0;
  const displayedRate = hasActiveQuoteInput ? executionRate : 0;
  const displayedImpact = hasActiveQuoteInput ? priceImpact : 0;
  const shownRate = flipRate && displayedRate > 0 ? 1 / displayedRate : displayedRate;
  const rateLeft = flipRate ? tokenName_2 : tokenName_1;
  const rateRight = flipRate ? tokenName_1 : tokenName_2;

  useEffect(() => {
    if (!predictData) {
      return;
    }
    if (lastChangedInput === 1 && !emptyPredict(predictData, amountInput.value)) {
      amountSendInput.onPredict(formatPredictAmount(fromGroths(effectiveBuyRaw)));
    }
    if (lastChangedInput === 2 && !emptyPredict(predictData, amountSendInput.value)) {
      amountInput.onPredict(formatPredictAmount(fromGroths(effectivePayRaw)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [predictData, lastChangedInput, effectiveBuyRaw, effectivePayRaw]);

  useEffect(() => {
    if (!hasActiveQuoteInput) {
      if (predictData) {
        dispatch(mainActions.setPredict(null));
      }
      if (lastChangedInput === 1) {
        amountSendInput.onPredict(0);
      } else {
        amountInput.onPredict(0);
      }
    }
  }, [hasActiveQuoteInput, predictData, dispatch, lastChangedInput]);

  const fromAmountFieldHandlers = createAmountFieldHandlers(predictData, amountInput, amountSendInput.value);
  const toAmountFieldHandlers = createAmountFieldHandlers(predictData, amountSendInput, amountInput.value);

  const applyTokenSelection = useCallback((side: SelectionSide, value: IOptions) => {
    if (side === 'from') {
      setCurrentToken(value?.value ?? null);
      if (value?.value === secondToken) {
        setSecondToken(currentToken);
      }
    } else {
      setSecondToken(value?.value ?? null);
      if (value?.value === currentToken) {
        setCurrentToken(secondToken);
      }
    }
    dispatch(mainActions.setPredict(null));
  }, [currentToken, secondToken, dispatch]);

  useEffect(() => {
    if (!pendingSelectionWarning) return;
    if (!fromSelectorOpen && !toSelectorOpen) {
      setSelectionWarning(pendingSelectionWarning);
      setPendingSelectionWarning(null);
    }
  }, [pendingSelectionWarning, fromSelectorOpen, toSelectorOpen]);

  const onSelectFromToken = useCallback((value: IOptions) => {
    const selectedId = value?.value ?? null;
    const realAssetId = getRealAssetIdForFake(selectedId);
    if (selectedId !== null && realAssetId !== null) {
      if (isDesktopClient) {
        setTimeout(() => {
          const tradeReal = window.confirm(
            `Asset id ${selectedId} is marked as an imposter.\nThe real asset id is: ${realAssetId}.\n\nPress OK to trade real asset.\nPress Cancel to continue anyways.`,
          );
          if (tradeReal) {
            applyTokenSelection('from', optionById(realAssetId));
          } else {
            applyTokenSelection('from', value);
          }
        }, 0);
        return true;
      }
      setPendingSelectionWarning({
        side: 'from',
        selectedOption: value,
        realAssetId,
      });
      setFromSelectorOpen(false);
      return true;
    }
    applyTokenSelection('from', value);
    return true;
  }, [applyTokenSelection, isDesktopClient, optionById]);

  const onSelectToToken = useCallback((value: IOptions) => {
    const selectedId = value?.value ?? null;
    const realAssetId = getRealAssetIdForFake(selectedId);
    if (selectedId !== null && realAssetId !== null) {
      if (isDesktopClient) {
        setTimeout(() => {
          const tradeReal = window.confirm(
            `Asset id ${selectedId} is marked as an imposter.\nThe real asset id is: ${realAssetId}.\n\nPress OK to trade real asset.\nPress Cancel to continue anyways.`,
          );
          if (tradeReal) {
            applyTokenSelection('to', optionById(realAssetId));
          } else {
            applyTokenSelection('to', value);
          }
        }, 0);
        return true;
      }
      setPendingSelectionWarning({
        side: 'to',
        selectedOption: value,
        realAssetId,
      });
      setToSelectorOpen(false);
      return true;
    }
    applyTokenSelection('to', value);
    return true;
  }, [applyTokenSelection, isDesktopClient, optionById]);

  const onSelectionWarningContinue = useCallback(() => {
    if (!selectionWarning) return;
    applyTokenSelection(selectionWarning.side, selectionWarning.selectedOption);
    setSelectionWarning(null);
  }, [selectionWarning, applyTokenSelection]);

  const onSelectionWarningTradeReal = useCallback(() => {
    if (!selectionWarning) return;
    applyTokenSelection(selectionWarning.side, optionById(selectionWarning.realAssetId));
    setSelectionWarning(null);
  }, [selectionWarning, applyTokenSelection, optionById]);

  const onReplaceSelectedWithRealAssets = useCallback(() => {
    let nextCurrent = currentToken;
    let nextSecond = secondToken;
    const realCurrent = getRealAssetIdForFake(currentToken);
    const realSecond = getRealAssetIdForFake(secondToken);

    if (realCurrent !== null) nextCurrent = realCurrent;
    if (realSecond !== null) nextSecond = realSecond;

    if (nextCurrent !== currentToken || nextSecond !== secondToken) {
      setCurrentToken(nextCurrent);
      setSecondToken(nextSecond);
      dispatch(mainActions.setPredict(null));
    }

    setTradeWarningOpen(false);
    setPendingTradeData(null);
  }, [currentToken, secondToken, dispatch]);

  const onTradeWithWarningCheck = useCallback((dataTrade: ITrade) => {
    if (!hasSelectedImposterAssets) {
      onTrade(dataTrade);
      return;
    }
    if (isDesktopClient) {
      const warningDetails = selectedImposterWarnings
        .map((w) => `fake id ${w.fakeAssetId}; real id ${w.realAssetId}`)
        .join('\n');
      const tradeReal = window.confirm(
        `Selected trading asset(s) are marked as potential imposters:\n${warningDetails}\n\nPress OK to switch to real asset(s).\nPress Cancel to continue anyways.`,
      );
      if (tradeReal) {
        onReplaceSelectedWithRealAssets();
        return;
      }
      onTrade(dataTrade);
      return;
    }
    setPendingTradeData(dataTrade);
    setTradeWarningOpen(true);
  }, [hasSelectedImposterAssets, isDesktopClient, onReplaceSelectedWithRealAssets, onTrade, selectedImposterWarnings]);

  const onTradeWarningContinue = useCallback(() => {
    if (pendingTradeData) {
      onTrade(pendingTradeData);
    }
    setTradeWarningOpen(false);
    setPendingTradeData(null);
  }, [pendingTradeData, onTrade]);

  function renderFeeTierRow() {
    if (matchedPools.length <= 1) return null;
    return (
      <FeeTierRow>
        {matchedPools.map((pool) => (
          <FeeTierButton
            key={pool.kind}
            active={activePool?.kind === pool.kind}
            onClick={() => {
              if (manualKind === null) setBestKind(data?.kind ?? null);
              setManualKind(pool.kind);
              dispatch(mainActions.setCurrentPool(pool));
            }}
          >
            {getPoolKind(pool.kind)}
            {(manualKind === null ? data?.kind : bestKind) === pool.kind && (
              <BestBadge>Best</BestBadge>
            )}
          </FeeTierButton>
        ))}
        {manualKind !== null && (
          <AutoButton
            onClick={() => {
              setManualKind(null);
              setBestKind(null);
              dispatch(mainActions.setCurrentPool(matchedPools[0]));
            }}
          >
            Auto
          </AutoButton>
        )}
      </FeeTierRow>
    );
  }

  function renderEmbeddedTradeSummary() {
    const payAssetId = currentToken ?? 0;
    return (
      <SummaryPanel>
        <SummaryHeader>trade summary</SummaryHeader>
        <SummaryWrapper style={{ marginTop: 0 }}>
          <TradeSummaryTable>
            <colgroup>
              <col style={{ width: 92 }} />
              <col style={{ width: 28 }} />
              <col />
            </colgroup>
            <tbody>
              <tr>
                <TradeSummaryTdLabel>
                  <TradeSummaryTitleInGrid>Rate</TradeSummaryTitleInGrid>
                </TradeSummaryTdLabel>
                <TradeSummaryTdIcon>
                  <TradeSummaryIconInner>
                    <RateSwitcherWrap>
                      <Button icon={IconExchange} variant="icon" onClick={() => setFlipRate((f) => !f)} />
                    </RateSwitcherWrap>
                  </TradeSummaryIconInner>
                </TradeSummaryTdIcon>
                <TradeSummaryTdValue>
                  <TradeSummaryValueInner>
                    <RateText>{`1 ${rateLeft} = ${shownRate.toLocaleString('en-US', { minimumFractionDigits: 8, maximumFractionDigits: 8 })} ${rateRight}`}</RateText>
                  </TradeSummaryValueInner>
                </TradeSummaryTdValue>
              </tr>
              <tr>
                <TradeSummaryTdLabel>
                  <TradeSummaryTitleInGrid>You buy</TradeSummaryTitleInGrid>
                </TradeSummaryTdLabel>
                <TradeSummaryTdIcon>
                  <TradeSummaryIconInner>
                    <AssetIcon asset_id={secondToken ?? 0} />
                  </TradeSummaryIconInner>
                </TradeSummaryTdIcon>
                <TradeSummaryTdValue>
                  <TradeSummaryValueInner>
                    {displayedBuyRaw >= 0 && (
                      <Amount>{formatNumber(fromGroths(displayedBuyRaw))}</Amount>
                    )}
                    <TradeSummaryNameId>
                      <PredictTitleStyled>{tokenName_2}</PredictTitleStyled>
                      <AssetsId>{`(id:${secondToken ?? 0})`}</AssetsId>
                    </TradeSummaryNameId>
                  </TradeSummaryValueInner>
                </TradeSummaryTdValue>
              </tr>
              <tr>
                <TradeSummaryTdLabel>
                  <TradeSummaryTitleInGrid>DAO Fee</TradeSummaryTitleInGrid>
                </TradeSummaryTdLabel>
                <TradeSummaryTdIcon>
                  <TradeSummaryIconInner>
                    <AssetIcon asset_id={payAssetId} />
                  </TradeSummaryIconInner>
                </TradeSummaryTdIcon>
                <TradeSummaryTdValue>
                  <TradeSummaryValueInner>
                    {displayedFeeDao >= 0 && (
                      <Amount>{formatNumber(fromGroths(displayedFeeDao))}</Amount>
                    )}
                    <TradeSummaryNameId>
                      <PredictTitleStyled>{tokenName_1}</PredictTitleStyled>
                      <AssetsId>{`(id:${payAssetId})`}</AssetsId>
                    </TradeSummaryNameId>
                  </TradeSummaryValueInner>
                </TradeSummaryTdValue>
              </tr>
              <tr>
                <TradeSummaryTdLabel>
                  <TradeSummaryTitleInGrid>LP Fee</TradeSummaryTitleInGrid>
                </TradeSummaryTdLabel>
                <TradeSummaryTdIcon>
                  <TradeSummaryIconInner>
                    <AssetIcon asset_id={payAssetId} />
                  </TradeSummaryIconInner>
                </TradeSummaryTdIcon>
                <TradeSummaryTdValue>
                  <TradeSummaryValueInner>
                    {displayedFeePool >= 0 && (
                      <Amount>{formatNumber(fromGroths(displayedFeePool))}</Amount>
                    )}
                    <TradeSummaryNameId>
                      <PredictTitleStyled>{tokenName_1}</PredictTitleStyled>
                      <AssetsId>{`(id:${payAssetId})`}</AssetsId>
                    </TradeSummaryNameId>
                  </TradeSummaryValueInner>
                </TradeSummaryTdValue>
              </tr>
              <tr>
                <TradeSummaryTdLabel>
                  <TradeSummaryTitleInGrid>Total Fee</TradeSummaryTitleInGrid>
                </TradeSummaryTdLabel>
                <TradeSummaryTdIcon>
                  <TradeSummaryIconInner>
                    <AssetIcon asset_id={payAssetId} />
                  </TradeSummaryIconInner>
                </TradeSummaryTdIcon>
                <TradeSummaryTdValue>
                  <TradeSummaryValueInner>
                    {displayedFeeTotal >= 0 && (
                      <Amount>{formatNumber(fromGroths(displayedFeeTotal))}</Amount>
                    )}
                    <TradeSummaryNameId>
                      <PredictTitleStyled>{tokenName_1}</PredictTitleStyled>
                      <AssetsId>{`(id:${payAssetId})`}</AssetsId>
                    </TradeSummaryNameId>
                  </TradeSummaryValueInner>
                </TradeSummaryTdValue>
              </tr>
              <tr>
                <TradeSummaryTdLabel>
                  <TradeSummaryTitleInGrid>Total Pay</TradeSummaryTitleInGrid>
                </TradeSummaryTdLabel>
                <TradeSummaryTdIcon>
                  <TradeSummaryIconInner>
                    <AssetIcon asset_id={payAssetId} />
                  </TradeSummaryIconInner>
                </TradeSummaryTdIcon>
                <TradeSummaryTdValue>
                  <TradeSummaryValueInner>
                    {displayedPayRaw >= 0 && (
                      <Amount>{formatNumber(fromGroths(displayedPayRaw))}</Amount>
                    )}
                    <TradeSummaryNameId>
                      <PredictTitleStyled>{tokenName_1}</PredictTitleStyled>
                      <AssetsId>{`(id:${payAssetId})`}</AssetsId>
                    </TradeSummaryNameId>
                  </TradeSummaryValueInner>
                </TradeSummaryTdValue>
              </tr>
              <tr>
                <TradeSummaryTdLabel>
                  <TradeSummaryTitleInGrid>Impact</TradeSummaryTitleInGrid>
                </TradeSummaryTdLabel>
                <TradeSummaryTdIcon aria-hidden>
                  <TradeSummaryIconInner />
                </TradeSummaryTdIcon>
                <TradeSummaryTdValue>
                  <TradeSummaryValueInner>
                    <PredictTitleStyled>{`${displayedImpact.toFixed(2)}%`}</PredictTitleStyled>
                  </TradeSummaryValueInner>
                </TradeSummaryTdValue>
              </tr>
            </tbody>
          </TradeSummaryTable>
        </SummaryWrapper>
      </SummaryPanel>
    );
  }

  const warningDialogs = (
    <>
      {selectionWarning && (
        <WarningModalBackdrop>
          <WarningModalPanel onClick={(e) => e.stopPropagation()}>
            <WarningTitle>Imposter asset warning</WarningTitle>
            <WarningText>
              {`You selected asset id ${selectionWarning.selectedOption.value},`}
              {' '}
              which is marked as an imposter.
              {' '}
              {`The real asset id is ${selectionWarning.realAssetId}.`}
            </WarningText>
            <WarningActions>
              <Button icon={DoneIcon} variant="approve" onClick={onSelectionWarningTradeReal}>
                Trade real asset
              </Button>
              <Button variant="control" onClick={onSelectionWarningContinue}>
                Continue anyways
              </Button>
            </WarningActions>
          </WarningModalPanel>
        </WarningModalBackdrop>
      )}

      {tradeWarningOpen && (
        <WarningModalBackdrop>
          <WarningModalPanel onClick={(e) => e.stopPropagation()}>
            <WarningTitle>Imposter asset warning</WarningTitle>
            <WarningText>
              One or more selected trading assets are marked as imposters:
            </WarningText>
            <WarningList>
              {selectedImposterWarnings.map((warning) => (
                <li key={`${warning.fakeAssetId}-${warning.realAssetId}`}>
                  {`fake id ${warning.fakeAssetId}; real id ${warning.realAssetId}`}
                </li>
              ))}
            </WarningList>
            <WarningActions>
              <Button icon={DoneIcon} variant="approve" onClick={onReplaceSelectedWithRealAssets}>
                Trade real asset
              </Button>
              <Button variant="control" onClick={onTradeWarningContinue}>
                Continue anyways
              </Button>
            </WarningActions>
          </WarningModalPanel>
        </WarningModalBackdrop>
      )}
    </>
  );
  const warningLayer = typeof document !== 'undefined'
    ? createPortal(warningDialogs, document.body)
    : warningDialogs;

  if (embedded) {
    return (
      <>
        <Window hideHeader>
          <Container wide>
            <EmbeddedLayout>
              <EmbeddedSwapColumn>
                <SwapCard>
                  <SwapBlock>
                    <BlockLabel>From</BlockLabel>
                    <AssetsSection error={fromAmountError}>
                      <InputRow>
                        <Input
                          ref={amountInputRef}
                          value={amountInput.value}
                          variant="amount"
                          pallete="blue"
                          valid={!fromAmountError}
                          onChange={handleAmountInputChange}
                          onFocus={fromAmountFieldHandlers.onFocus}
                          onBlur={fromAmountFieldHandlers.onBlur}
                        />
                        <InlineSelect>
                          <AssetSelectorButton
                            value={selectValue(currentToken)}
                            onSelect={onSelectFromToken}
                            excludeAssetId={secondToken}
                            placeholder="Select asset"
                            showWarning={isImposterAsset(currentToken)}
                            isOpen={fromSelectorOpen}
                            onOpen={() => setFromSelectorOpen(true)}
                            onClose={() => setFromSelectorOpen(false)}
                          />
                        </InlineSelect>
                      </InputRow>
                    </AssetsSection>
                    <HintRow>
                      {fromAmountError && <ErrorHint>amount exceeds pool reserves</ErrorHint>}
                    </HintRow>
                  </SwapBlock>
                  <EmbeddedExchangeWrap>
                    <Button icon={IconExchange} variant="icon" onClick={swapTokensAndResetSend} />
                  </EmbeddedExchangeWrap>
                  <SwapBlock>
                    <BlockLabel>To</BlockLabel>
                    <AssetsSection error={toAmountError}>
                      <InputRow>
                        <Input
                          ref={amountSendInputRef}
                          pallete="purple"
                          variant="amount"
                          style={toAmountError ? { cursor: 'default', opacity: 1 } : receiveAmountInputStyle}
                          value={amountSendInput.value}
                          valid={!toAmountError}
                          onChange={handleAmountSendInputChange}
                          onFocus={toAmountFieldHandlers.onFocus}
                          onBlur={toAmountFieldHandlers.onBlur}
                        />
                        <InlineSelect>
                          <AssetSelectorButton
                            value={selectValue(secondToken)}
                            onSelect={onSelectToToken}
                            excludeAssetId={currentToken}
                            allowedAssetIds={currentToken === null ? null : toPoolPartnerIds}
                            placeholder="Select asset"
                            showWarning={isImposterAsset(secondToken)}
                            isOpen={toSelectorOpen}
                            onOpen={() => setToSelectorOpen(true)}
                            onClose={() => setToSelectorOpen(false)}
                          />
                        </InlineSelect>
                      </InputRow>
                    </AssetsSection>
                    <HintRow>
                      {toAmountError && <ErrorHint>amount exceeds pool reserves</ErrorHint>}
                    </HintRow>
                  </SwapBlock>
                  <EmbeddedTradeButtonWrap>
                    <Button
                      disabled={isTradeDisabled}
                      icon={DoneIcon}
                      variant="approve"
                      onClick={() => requestData && onTradeWithWarningCheck(requestData)}
                    >
                      Trade
                    </Button>
                  </EmbeddedTradeButtonWrap>
                </SwapCard>
              </EmbeddedSwapColumn>
              <EmbeddedRightStack>
                <RightPanel>
                  {activePool ? (
                    <>
                      <PoolStat data={activePool} lp={currentLPToken} showFavorite plain />
                      {renderFeeTierRow()}
                      <EmbeddedActionRow className="trade-embedded-actions">
                        <Button
                          className="trade-embedded-action-button"
                          icon={IconShieldChecked}
                          variant="control"
                          onClick={() => navigate(ROUTES.POOLS.ADD_LIQUIDITY)}
                          disabled={!activePool}
                        >
                          add
                        </Button>
                        <Button
                          className="trade-embedded-action-button"
                          icon={IconReceive}
                          variant="control"
                          pallete="blue"
                          onClick={() => navigate(ROUTES.POOLS.WITHDRAW_POOL)}
                          disabled={!activePool}
                        >
                          Withdraw
                        </Button>
                        {showRewardsButton && (
                        <Button
                          className="trade-embedded-action-button"
                          variant="control"
                          pallete="purple"
                          onClick={() => navigate(ROUTES.POOLS.ACCUMULATOR_REWARDS)}
                          disabled={!activePool}
                        >
                          $ rewards
                        </Button>
                        )}
                      </EmbeddedActionRow>
                    </>
                  ) : (
                    <EmptyPoolState>No pool matches this pair and filter combination.</EmptyPoolState>
                  )}
                </RightPanel>
                <EmbeddedTradeSummaryBelowPool>
                  {renderEmbeddedTradeSummary()}
                </EmbeddedTradeSummaryBelowPool>
              </EmbeddedRightStack>
            </EmbeddedLayout>
          </Container>
        </Window>
        {warningLayer}
      </>
    );
  }

  return (
    <>
      <Window title="trade" backButton>
        <Container>
          <SelectWrapper>
            <SearchHint>Search asset directly inside each amount row selector.</SearchHint>
          </SelectWrapper>
          <AssetsContainer>
            <Section title={titleSections.TRADE_RECEIVE}>
              <AssetsSection error={fromAmountError}>
                <InputRow>
                  <Input
                    ref={amountInputRef}
                    value={amountInput.value}
                    variant="amount"
                    pallete="blue"
                    valid={!fromAmountError}
                    onChange={handleAmountInputChange}
                    onFocus={fromAmountFieldHandlers.onFocus}
                    onBlur={fromAmountFieldHandlers.onBlur}
                  />
                  <InlineSelect>
                    <AssetSelectorButton
                      value={selectValue(currentToken)}
                      onSelect={onSelectFromToken}
                      excludeAssetId={secondToken}
                      placeholder="Select asset"
                      showWarning={isImposterAsset(currentToken)}
                      isOpen={fromSelectorOpen}
                      onOpen={() => setFromSelectorOpen(true)}
                      onClose={() => setFromSelectorOpen(false)}
                    />
                  </InlineSelect>
                </InputRow>
              </AssetsSection>
              {fromAmountError && <HintRow><ErrorHint>amount exceeds pool reserves</ErrorHint></HintRow>}
              <ExchangeWrapper>
                <Button icon={IconExchange} variant="icon" onClick={swapTokensAndResetSend} />
              </ExchangeWrapper>
            </Section>
            <Section title={titleSections.TRADE_SEND}>
              <AssetsSection error={toAmountError}>
                <InputRow>
                  <Input
                    ref={amountSendInputRef}
                    pallete="purple"
                    variant="amount"
                    style={receiveAmountInputStyle}
                    value={amountSendInput.value}
                    valid={!toAmountError}
                    onChange={handleAmountSendInputChange}
                    onFocus={toAmountFieldHandlers.onFocus}
                    onBlur={toAmountFieldHandlers.onBlur}
                  />
                  <InlineSelect>
                    <AssetSelectorButton
                      value={selectValue(secondToken)}
                      onSelect={onSelectToToken}
                      excludeAssetId={currentToken}
                      allowedAssetIds={currentToken === null ? null : toPoolPartnerIds}
                      placeholder="Select asset"
                      showWarning={isImposterAsset(secondToken)}
                      isOpen={toSelectorOpen}
                      onOpen={() => setToSelectorOpen(true)}
                      onClose={() => setToSelectorOpen(false)}
                    />
                  </InlineSelect>
                </InputRow>
              </AssetsSection>
              {toAmountError && <HintRow><ErrorHint>amount exceeds pool reserves</ErrorHint></HintRow>}
            </Section>
          </AssetsContainer>
          <SectionWrapper>
            {activePool ? (
              <>
                <PoolStat data={activePool} lp={currentLPToken} />
                {renderFeeTierRow()}
              </>
            ) : null}
            <Section title="trade summary">
              <SummaryWrapper>
                <SummaryContainer>
                  <SummaryTitle>You buy</SummaryTitle>
                  <SummaryAsset>
                    <AssetAmount>
                      <AssetLabel
                        variant="predict"
                        title={tokenName_2}
                        assets_id={secondToken ?? 0}
                        amount={predictData ? predictData.buy : 0}
                      />
                    </AssetAmount>
                  </SummaryAsset>
                </SummaryContainer>
                <SummaryContainer>
                  <SummaryTitle>DAO Fee</SummaryTitle>
                  <SummaryAsset>
                    <AssetAmount>
                      <AssetLabel
                        variant="predict"
                        title={tokenName_1}
                        assets_id={currentToken ?? 0}
                        amount={predictData ? predictData.fee_dao : 0}
                      />
                    </AssetAmount>
                  </SummaryAsset>
                </SummaryContainer>
                <SummaryContainer>
                  <SummaryTitle>Pool Fee</SummaryTitle>
                  <SummaryAsset>
                    <AssetAmount>
                      <AssetLabel
                        variant="predict"
                        title={tokenName_1}
                        assets_id={currentToken ?? 0}
                        amount={predictData ? predictData.fee_pool : 0}
                      />
                    </AssetAmount>
                  </SummaryAsset>
                </SummaryContainer>
                <Line />
                <SummaryContainer>
                  <TotalTitle>Total Pay</TotalTitle>
                  <SummaryAsset>
                    <AssetAmount>
                      <div>
                        <AssetLabel
                          variant="predict"
                          title={tokenName_1}
                          assets_id={currentToken ?? 0}
                          amount={predictData ? predictData.pay : 0}
                          id={false}
                        />
                      </div>
                    </AssetAmount>
                  </SummaryAsset>
                </SummaryContainer>
              </SummaryWrapper>
            </Section>
          </SectionWrapper>
          <ButtonBlock>
            <ButtonWrapper>
              <Button icon={CancelIcon} variant="cancel" onClick={onPreviousClick}>
                Cancel
              </Button>
              <Button
                disabled={isTradeDisabled}
                icon={DoneIcon}
                variant="approve"
                onClick={() => requestData && onTradeWithWarningCheck(requestData)}
              >
                Trade
              </Button>
            </ButtonWrapper>
          </ButtonBlock>
        </Container>
      </Window>
      {warningLayer}
    </>
  );
};
