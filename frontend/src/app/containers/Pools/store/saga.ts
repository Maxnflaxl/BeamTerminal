import {
  all, call, delay, put, select, takeLatest,
} from 'redux-saga/effects';
import {
  IAsset, IPoolCard, ITxId, ITxResult, ITxStatus, TxStatus,
} from '@core/types';
import {
  AddLiquidityApi,
  CreatePoolApi,
  LoadAssetsList,
  LoadPoolsList,
  LockAccumulatorApi,
  PredictAccumulatorYieldApi,
  toContractCallConfig,
  TradePoolApi,
  UpdateAccumulatorUserApi,
  ViewAccumulatorParamsApi,
  ViewAccumulatorUserApi,
  WithdrawApi,
} from '@core/api';
import {
  checkTxStatus,
  getOptions,
  isInArray,
  onFilter,
  parseMetadata,
  parsePoolMetadata,
  setStorage,
} from '@core/appUtils';
import { ensureConnected } from '@core/walletEnv';
import { AppState } from '@app/shared/interface';
import * as mainActions from '@app/containers/Pools/store/actions';
import {
  selectCurrentPool,
  selectFavorites,
  selectFilter,
  selectShaderRuntimeMap,
} from '@app/containers/Pools/store/selectors';
import { toast } from 'react-toastify';
import { navigate } from '@app/shared/store/actions';
import { ROUTES } from '@app/shared/constants';
import { actions as Shared } from '@app/shared/store/index';
import { ShaderRuntimeMap } from '@app/core/shaderRegistry';
import { actions } from '.';

const DEFAULT_LOCK_OPTIONS = [
  { value: 1, label: '1 month' },
  { value: 3, label: '3 months' },
  { value: 6, label: '6 months' },
  { value: 12, label: '12 months' },
];

function* selectAmmCallConfig() {
  const shaderRuntimeMap = (yield select(selectShaderRuntimeMap())) as ShaderRuntimeMap | null;
  return toContractCallConfig(shaderRuntimeMap?.amm);
}

function* selectAccumulatorCallConfig() {
  const shaderRuntimeMap = (yield select(selectShaderRuntimeMap())) as ShaderRuntimeMap | null;
  return toContractCallConfig(shaderRuntimeMap?.accumulator);
}

export function* loadParamsSaga(action: ReturnType<typeof actions.loadAppParams.request>): Generator {
  try {
    yield put(mainActions.setShaderRuntimeMap(action.payload));
    yield setStorage();
    const favoritesLocal = JSON.parse(localStorage.getItem('favorites')) || [];
    const favoriteAssetsLocal: number[] = JSON.parse(localStorage.getItem('favoriteAssets')) || [];
    const filter = yield select(selectFilter());
    let assetsList: IAsset[] = [];
    try {
      assetsList = (yield call(LoadAssetsList)) as IAsset[];
    } catch (_error) {
      // Keep loading contract/pool data even if wallet assets endpoint fails.
      assetsList = [];
    }
    assetsList.forEach((asset) => {
      asset.parsedMetadata = parseMetadata(asset.metadata);
    });
    yield put(mainActions.setFavorites(favoritesLocal));
    yield put(mainActions.setFavoriteAssets(favoriteAssetsLocal));
    yield put(mainActions.setAssetsList(assetsList));
    const options = getOptions(assetsList);
    yield put(mainActions.setOptions(options));
    const ammConfig = (yield selectAmmCallConfig()) as ReturnType<typeof toContractCallConfig>;
    const poolsList = (yield call(LoadPoolsList, ammConfig)) as IPoolCard[];
    const newPoolList: IPoolCard[] = poolsList.map((pool) => parsePoolMetadata(pool, pool.aid1, pool.aid2, assetsList));
    const filteredPools = onFilter(newPoolList, filter as string, favoritesLocal) as IPoolCard[];
    yield put(mainActions.setPoolsList(filteredPools));
    yield put(Shared.setIsLoaded(true));
  } catch (e) {
    // @ts-ignore
    yield put(mainActions.loadAppParams.failure(e));
    yield put(Shared.setIsLoaded(true));
    toast(e.error);
  }
}
function* navigateToHome(txid: string) {
  if (txid) {
    yield put(navigate(ROUTES.POOLS.BASE));
  }
}
function* getStatus(txid: string) {
  const listStatus = yield select((state: AppState) => state.main.tx_status);
  const status = yield checkTxStatus(txid, listStatus as ITxStatus[]);
  if (status === TxStatus.Completed) {
    yield put(mainActions.setTransactionStatus(status));
    yield toast('Transaction is Completed');
    yield delay(1000);
    yield put(mainActions.setTransactionStatus(null));
  } else if (status === TxStatus.Failed) {
    yield toast('Transaction is Failed');
    yield put(mainActions.setTransactionStatus(status));
    yield delay(1000);
    yield put(mainActions.setTransactionStatus(null));
  } else if (status === TxStatus.Canceled) {
    yield put(mainActions.setTransactionStatus(status));
    yield delay(1000);
    yield put(mainActions.setTransactionStatus(null));
  } else if (status === TxStatus.InProgress || TxStatus.Registering) {
    yield put(mainActions.setTransactionStatus(status));
    yield delay(500);
    yield getStatus(txid);
  }
}
function* requireWallet(): Generator<unknown, boolean, boolean> {
  const ok = (yield call(ensureConnected)) as boolean;
  if (!ok) toast('Open this page in the BEAM Wallet to sign transactions.');
  return ok;
}

export function* createPool(action: ReturnType<typeof mainActions.onCreatePool.request>): Generator {
  const ok = (yield call(requireWallet)) as boolean;
  if (!ok) return;
  try {
    const ammConfig = (yield selectAmmCallConfig()) as ReturnType<typeof toContractCallConfig>;
    // @ts-ignore
    const { txid } = (yield call(CreatePoolApi, action.payload ? action.payload : null, ammConfig)) as ITxId;
    if (txid) {
      yield navigateToHome(txid);
      yield getStatus(txid);
    }
  } catch (e) {
    // @ts-ignore
    yield put(mainActions.onCreatePool.failure(e));
    toast(e.error === 'pool already exists' ? 'This pool already exists' : e.error);
  }
}

export function* addLiquidity(action: ReturnType<typeof mainActions.onAddLiquidity.request>): Generator {
  const ok = (yield call(requireWallet)) as boolean;
  if (!ok) return;
  try {
    const ammConfig = (yield selectAmmCallConfig()) as ReturnType<typeof toContractCallConfig>;
    // @ts-ignore
    const {
      txid,
      res,
    } = (yield call(AddLiquidityApi, action.payload ? action.payload : null, ammConfig)) as ITxResult;
    if (res) {
      yield put(mainActions.setPredict(res));
    }
    if (txid) {
      // Auto-add pool to favorites on successful liquidity add
      const currentPool = (yield select(selectCurrentPool())) as IPoolCard;
      const favoritesList = (yield select(selectFavorites())) as IPoolCard[];
      if (currentPool && !isInArray(currentPool, favoritesList)) {
        const updated = [...favoritesList, currentPool];
        yield localStorage.setItem('favorites', JSON.stringify(updated));
        yield put(mainActions.setFavorites(updated));
      }
      yield navigateToHome(txid);
      yield getStatus(txid);
    }
  } catch (e) {
    // @ts-ignore
    yield put(mainActions.onAddLiquidity.failure(e));
  }
}
export function* predictTrade(action: ReturnType<typeof mainActions.onPredictTrade.request>): Generator {
  try {
    const ammConfig = (yield selectAmmCallConfig()) as ReturnType<typeof toContractCallConfig>;
    // @ts-ignore
    const { res } = (yield call(TradePoolApi, action.payload ? action.payload : null, ammConfig)) as ITxResult;
    if (res) {
      yield put(mainActions.setPredict(res));
    }
  } catch (e) {
    // @ts-ignore
    yield put(mainActions.setErrorMessage(e));
  }
}
export function* tradePool(action: ReturnType<typeof mainActions.onTradePool.request>): Generator {
  const ok = (yield call(requireWallet)) as boolean;
  if (!ok) return;
  try {
    const ammConfig = (yield selectAmmCallConfig()) as ReturnType<typeof toContractCallConfig>;
    // @ts-ignore
    const {
      res,
      txid,
    } = (yield call(TradePoolApi, action.payload ? action.payload : null, ammConfig)) as ITxResult;
    if (res) {
      yield put(mainActions.setPredict(res));
    }
    if (txid) {
      yield navigateToHome(txid);
      yield getStatus(txid);
    }
  } catch (e) {
    // @ts-ignore
    yield put(mainActions.setErrorMessage(e));
  }
}
export function* withdrawPool(action: ReturnType<typeof mainActions.onWithdraw.request>): Generator {
  const ok = (yield call(requireWallet)) as boolean;
  if (!ok) return;
  try {
    const ammConfig = (yield selectAmmCallConfig()) as ReturnType<typeof toContractCallConfig>;
    // @ts-ignore
    const {
      res,
      txid,
    } = (yield call(WithdrawApi, action.payload ? action.payload : null, ammConfig)) as ITxResult;
    if (res) {
      yield put(mainActions.setPredict(res));
    }
    if (txid) {
      yield navigateToHome(txid);
      yield getStatus(txid);
    }
  } catch (e) {
    // @ts-ignore
    yield put(mainActions.onWithdraw.failure(e));
  }
}
export function* favorites(action: ReturnType<typeof mainActions.onFavorites.request>): Generator {
  try {
    const favoritesList = yield select((state: AppState) => state.main.favorites);
    const pool = action.payload as IPoolCard;
    let storage = (favoritesList as IPoolCard[]) || [];
    if (storage) {
      const isFav = isInArray(pool, storage);
      if (isFav) {
        const filtered = storage.filter(
          (e: IPoolCard) => !(e.aid1 === pool.aid1 && e.aid2 === pool.aid2 && e.kind === pool.kind),
        );
        yield localStorage.setItem('favorites', JSON.stringify(filtered));
        yield put(mainActions.setFavorites(filtered as IPoolCard[]));
        return;
      }
      storage = [...storage, pool];
    } else {
      storage.push(pool);
    }
    yield localStorage.setItem('favorites', JSON.stringify(storage));
    yield put(mainActions.setFavorites(storage as IPoolCard[]));
  } catch (e) {
    // @ts-ignore
    // yield put(mainActions.onWithdraw.failure(e));
    toast(e.error);
  }
}

export function* favoriteAsset(action: ReturnType<typeof mainActions.onToggleFavoriteAsset.request>): Generator {
  try {
    const assetId = action.payload as number;
    const current = (yield select((state: AppState) => state.main.favoriteAssets)) as number[];
    const list = current || [];
    const updated = list.includes(assetId)
      ? list.filter((id) => id !== assetId)
      : [...list, assetId];
    yield localStorage.setItem('favoriteAssets', JSON.stringify(updated));
    yield put(mainActions.setFavoriteAssets(updated));
  } catch (e) {
    toast(e.error);
  }
}

export function* findBestPool(action: ReturnType<typeof mainActions.onFindBestPool.request>): Generator {
  const {
    pools, aid1, aid2, val2_pay, val1_buy,
  } = action.payload;

  const predictParams = {
    aid1,
    aid2,
    val2_pay: val2_pay || 0,
    val1_buy: val1_buy || 0,
    bPredictOnly: 1,
  };
  const ammConfig = (yield selectAmmCallConfig()) as ReturnType<typeof toContractCallConfig>;

  // @ts-ignore – fire all pool predictions in parallel
  const results: Array<{ pool: IPoolCard; result: ITxResult | null }> = yield all(
    pools.map((pool: IPoolCard) => call(function* () {
      try {
        const result = (yield call(TradePoolApi, { ...predictParams, kind: pool.kind }, ammConfig)) as ITxResult;
        return { pool, result };
      } catch (_) {
        return { pool, result: null };
      }
    })),
  );

  let bestPool = pools[0];
  let bestBuy = -1;
  let bestResult: ITxResult | null = null;

  for (const { pool, result } of results) {
    const buy = result?.res?.buy ?? 0;
    if (buy > bestBuy) {
      bestBuy = buy;
      bestPool = pool;
      bestResult = result;
    }
  }

  if (bestBuy > 0) {
    yield put(mainActions.setCurrentPool(bestPool));
    if (bestResult?.res) {
      yield put(mainActions.setPredict(bestResult.res));
    }
  }
}

function parseAccumulatorLocks(userView: any): any[] {
  if (!userView) return [];
  if (Array.isArray(userView.res)) return userView.res;
  if (Array.isArray(userView['res-nph'])) return userView['res-nph'];
  if (Array.isArray(userView)) return userView;
  return [];
}

function parseLpBalance(userView: any): number {
  if (!userView) return 0;
  if (typeof userView['lpToken-post'] === 'number') return userView['lpToken-post'];
  if (userView.res && typeof userView.res['lpToken-post'] === 'number') return userView.res['lpToken-post'];
  return 0;
}

export function* loadAccumulatorRewards(action: ReturnType<typeof mainActions.loadAccumulatorRewards.request>): Generator {
  const { pool } = action.payload;
  if (!pool) {
    yield put(mainActions.setRewardsState({
      isAvailable: false,
      isLoading: false,
      error: null,
      lpTokenBalance: 0,
      estimatedReward: 0,
      locks: [],
      lockOptions: DEFAULT_LOCK_OPTIONS,
    }));
    return;
  }

  try {
    yield put(mainActions.setRewardsState({ isLoading: true, error: null }));
    const accumulatorConfig = (yield selectAccumulatorCallConfig()) as ReturnType<typeof toContractCallConfig>;
    const params = (yield call(ViewAccumulatorParamsApi, accumulatorConfig)) as Record<string, any>;
    const userView = (yield call(ViewAccumulatorUserApi, accumulatorConfig)) as Record<string, any>;
    const locks = parseAccumulatorLocks(userView);
    const lpTokenBalance = parseLpBalance(userView);
    const hasRemaining = Number(params?.['farm-remaining-height'] || params?.['farm-nph-remaining-height'] || 0) > 0;
    yield put(mainActions.setRewardsState({
      isLoading: false,
      isAvailable: hasRemaining || lpTokenBalance > 0 || locks.length > 0,
      lockOptions: DEFAULT_LOCK_OPTIONS,
      locks,
      lpTokenBalance,
      error: null,
    }));
  } catch (error: any) {
    yield put(mainActions.setRewardsState({
      isLoading: false,
      isAvailable: false,
      error: error?.message || 'Failed to load rewards',
      lockOptions: DEFAULT_LOCK_OPTIONS,
      locks: [],
      lpTokenBalance: 0,
      estimatedReward: 0,
    }));
  }
}

export function* predictAccumulatorRewards(
  action: ReturnType<typeof mainActions.predictAccumulatorRewards.request>,
): Generator {
  try {
    const accumulatorConfig = (yield selectAccumulatorCallConfig()) as ReturnType<typeof toContractCallConfig>;
    const response = (yield call(PredictAccumulatorYieldApi, action.payload, accumulatorConfig)) as any;
    const estimatedReward = Number(response?.res?.reward || response?.reward || 0);
    yield put(mainActions.setRewardsState({ estimatedReward }));
  } catch (_) {
    yield put(mainActions.setRewardsState({ estimatedReward: 0 }));
  }
}

export function* lockAccumulatorRewards(
  action: ReturnType<typeof mainActions.lockAccumulatorRewards.request>,
): Generator {
  try {
    const accumulatorConfig = (yield selectAccumulatorCallConfig()) as ReturnType<typeof toContractCallConfig>;
    const response = (yield call(LockAccumulatorApi, action.payload, accumulatorConfig)) as { txid?: string };
    if (response?.txid) {
      toast('Rewards lock transaction submitted');
      yield put(mainActions.loadAccumulatorRewards.request({ pool: (yield select(selectCurrentPool())) as IPoolCard }));
    }
  } catch (error: any) {
    yield put(mainActions.lockAccumulatorRewards.failure(error, null));
    toast(error?.message || 'Failed to lock rewards');
  }
}

export function* updateAccumulatorRewards(
  action: ReturnType<typeof mainActions.updateAccumulatorRewards.request>,
): Generator {
  try {
    const accumulatorConfig = (yield selectAccumulatorCallConfig()) as ReturnType<typeof toContractCallConfig>;
    const response = (yield call(UpdateAccumulatorUserApi, action.payload, accumulatorConfig)) as { txid?: string };
    if (response?.txid) {
      toast('Rewards action transaction submitted');
      yield put(mainActions.loadAccumulatorRewards.request({ pool: (yield select(selectCurrentPool())) as IPoolCard }));
    }
  } catch (error: any) {
    yield put(mainActions.updateAccumulatorRewards.failure(error, null));
    toast(error?.message || 'Failed to update rewards');
  }
}

function* mainSaga() {
  yield takeLatest(mainActions.loadAppParams.request, loadParamsSaga);
  yield takeLatest(mainActions.onCreatePool.request, createPool);
  yield takeLatest(mainActions.onAddLiquidity.request, addLiquidity);
  yield takeLatest(mainActions.onPredictTrade.request, predictTrade);
  yield takeLatest(mainActions.onTradePool.request, tradePool);
  yield takeLatest(mainActions.onWithdraw.request, withdrawPool);
  yield takeLatest(mainActions.onFavorites.request, favorites);
  yield takeLatest(mainActions.onToggleFavoriteAsset.request, favoriteAsset);
  yield takeLatest(mainActions.onFindBestPool.request, findBestPool);
  yield takeLatest(mainActions.loadAccumulatorRewards.request, loadAccumulatorRewards);
  yield takeLatest(mainActions.predictAccumulatorRewards.request, predictAccumulatorRewards);
  yield takeLatest(mainActions.lockAccumulatorRewards.request, lockAccumulatorRewards);
  yield takeLatest(mainActions.updateAccumulatorRewards.request, updateAccumulatorRewards);
}

export default mainSaga;
