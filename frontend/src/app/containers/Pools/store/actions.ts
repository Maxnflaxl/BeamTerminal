import { createAction, createAsyncAction } from 'typesafe-actions';
import {
  IAddLiquidity,
  IAsset,
  ICreatePool,
  IOptions,
  IPoolCard,
  IPredict,
  ITrade,
  ITxStatus,
  IWithdraw,
  KindProcent,
} from '@core/types';
import { ShaderRuntimeMap } from '@app/core/shaderRegistry';
import { AccumulatorRewardsState } from '@app/containers/Pools/interfaces/DexStateType';
import { MainActionsTypes } from '@app/containers/Pools/store/constants';

export const setAssetsList = createAction(MainActionsTypes.SET_ASSETS_LIST)<IAsset[]>();
export const setPoolsList = createAction(MainActionsTypes.SET_POOLS_LIST)<IPoolCard[]>();
export const setTxStatus = createAction(MainActionsTypes.SET_TX_STATUS)<ITxStatus[]>();
export const setErrorMessage = createAction(MainActionsTypes.SET_ERROR_MESSAGE)<string | null>();
export const setTransactionStatus = createAction(MainActionsTypes.SET_TRANSACTIONS_STATUS)<number>();
export const setPredict = createAction(MainActionsTypes.SET_PREDICT)<IPredict>();
export const setCurrentPool = createAction(MainActionsTypes.SET_CURRENT_POOL)<IPoolCard>();
export const setFilter = createAction(MainActionsTypes.SET_FILTER)<string>();
export const setFeeFilter = createAction(MainActionsTypes.SET_FEE_FILTER)<KindProcent | null>();
export const setOptions = createAction(MainActionsTypes.SET_OPTIONS)<IOptions[]>();
export const setFavorites = createAction(MainActionsTypes.SET_FAVORITES)<IPoolCard[]>();
export const setFavoriteAssets = createAction(MainActionsTypes.SET_FAVORITE_ASSETS)<number[]>();
export const onToggleFavoriteAsset = createAsyncAction(
  MainActionsTypes.TOGGLE_FAVORITE_ASSET,
  MainActionsTypes.TOGGLE_FAVORITE_ASSET_SUCCESS,
  MainActionsTypes.TOGGLE_FAVORITE_ASSET_FAILURE,
)<number, number[], any>();
export const setCurrentLPToken = createAction(MainActionsTypes.SET_CURRENT_LP_TOKEN)<IPoolCard>();
export const setIsLoading = createAction(MainActionsTypes.SET_IS_LOADING)<boolean>();
export const setIsHeadless = createAction(MainActionsTypes.SET_IS_HEADLESS)<boolean>();

export const loadAppParams = createAsyncAction(
  MainActionsTypes.LOAD_PARAMS,
  MainActionsTypes.LOAD_PARAMS_SUCCESS,
  MainActionsTypes.LOAD_PARAMS_FAILURE,
)<ArrayBuffer, any>();

export const loadPoolsList = createAsyncAction(
  MainActionsTypes.LOAD_POOLS_LIST,
  MainActionsTypes.LOAD_POOLS_LIST_SUCCESS,
  MainActionsTypes.LOAD_POOLS_LIST_FAILURE,
)<ArrayBuffer, any>();
export const onCreatePool = createAsyncAction(
  MainActionsTypes.CREATE_POOL,
  MainActionsTypes.CREATE_POOL_SUCCESS,
  MainActionsTypes.CREATE_POOL_FAILURE,
)<ICreatePool[], any>();
export const onAddLiquidity = createAsyncAction(
  MainActionsTypes.ADD_LIQUIDITY,
  MainActionsTypes.ADD_LIQUIDITY_SUCCESS,
  MainActionsTypes.ADD_LIQUIDITY_FAILURE,
)<IAddLiquidity, any>();

export const onTradePool = createAsyncAction(
  MainActionsTypes.TRADE_POOL,
  MainActionsTypes.TRADE_POOL_SUCCESS,
  MainActionsTypes.TRADE_POOL_FAILURE,
)<ITrade, any>();
export const onWithdraw = createAsyncAction(
  MainActionsTypes.WITHDRAW,
  MainActionsTypes.WITHDRAW_SUCCESS,
  MainActionsTypes.WITHDRAW_FAILURE,
)<IWithdraw, any>();
export const onFavorites = createAsyncAction(
  MainActionsTypes.FAVORITES,
  MainActionsTypes.FAVORITES_SUCCESS,
  MainActionsTypes.FAVORITES_FAILURE,
)<IWithdraw, any>();
export const onFilterz = createAsyncAction(
  MainActionsTypes.FILTERZ,
  MainActionsTypes.FILTERZ_SUCCESS,
  MainActionsTypes.FILTERZ_FAILURE,
)<IWithdraw, any>();
export const onPredictTrade = createAsyncAction(
  MainActionsTypes.PREDICT_TRADE,
  MainActionsTypes.PREDICT_TRADE_SUCCESS,
  MainActionsTypes.PREDICT_TRADE_FAILURE,
)<ITrade, any>();
export const onFindBestPool = createAsyncAction(
  MainActionsTypes.FIND_BEST_POOL,
  MainActionsTypes.FIND_BEST_POOL_SUCCESS,
  MainActionsTypes.FIND_BEST_POOL_FAILURE,
)<{ pools: IPoolCard[]; aid1: number; aid2: number; val2_pay?: number; val1_buy?: number }, IPoolCard, any>();

export const setShaderRuntimeMap = createAction(MainActionsTypes.SET_SHADER_RUNTIME_MAP)<ShaderRuntimeMap>();
export const setRewardsState = createAction(MainActionsTypes.SET_REWARDS_STATE)<Partial<AccumulatorRewardsState>>();

export const loadAccumulatorRewards = createAsyncAction(
  MainActionsTypes.LOAD_ACCUMULATOR_REWARDS,
  MainActionsTypes.LOAD_ACCUMULATOR_REWARDS_SUCCESS,
  MainActionsTypes.LOAD_ACCUMULATOR_REWARDS_FAILURE,
)<{ pool: IPoolCard | null }, void, any>();

export const predictAccumulatorRewards = createAsyncAction(
  MainActionsTypes.PREDICT_ACCUMULATOR_REWARDS,
  MainActionsTypes.PREDICT_ACCUMULATOR_REWARDS_SUCCESS,
  MainActionsTypes.PREDICT_ACCUMULATOR_REWARDS_FAILURE,
)<{ amountLpToken: number; lockPeriods: number; isNph?: number }, any, any>();

export const lockAccumulatorRewards = createAsyncAction(
  MainActionsTypes.LOCK_ACCUMULATOR_REWARDS,
  MainActionsTypes.LOCK_ACCUMULATOR_REWARDS_SUCCESS,
  MainActionsTypes.LOCK_ACCUMULATOR_REWARDS_FAILURE,
)<{ amountLpToken: number; lockPeriods: number; isNph?: number }, any, any>();

export const updateAccumulatorRewards = createAsyncAction(
  MainActionsTypes.UPDATE_ACCUMULATOR_REWARDS,
  MainActionsTypes.UPDATE_ACCUMULATOR_REWARDS_SUCCESS,
  MainActionsTypes.UPDATE_ACCUMULATOR_REWARDS_FAILURE,
)<{ withdrawBeamX: number; withdrawLpToken: number; hEnd: number; isNph?: number }, any, any>();
