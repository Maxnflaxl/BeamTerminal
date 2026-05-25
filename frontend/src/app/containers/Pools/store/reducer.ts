import { AccumulatorRewardsState, DexStateType } from '@app/containers/Pools/interfaces/DexStateType';
import { ActionType, createReducer } from 'typesafe-actions';
import produce from 'immer';
import * as actions from './actions';

type Action = ActionType<typeof actions>;

const initialRewardsState: AccumulatorRewardsState = {
  isAvailable: false,
  isLoading: false,
  error: null,
  lpTokenBalance: 0,
  estimatedReward: 0,
  locks: [],
  lockOptions: [],
};

const initialState: DexStateType = {
  assetsList: [],
  poolsList: [],
  tx_status: null,
  statusTransaction: null,
  predict: null,
  currentPool: null,
  filter: 'all',
  feeFilter: null,
  options: [],
  favorites: [],
  favoriteAssets: [],
  currentLPToken: null,
  isLoading: false,
  isHeadless: true,
  shaderRuntimeMap: null,
  rewards: initialRewardsState,
};

const reducer = createReducer<DexStateType, Action>(initialState)
  .handleAction(actions.setAssetsList, (state, action) => produce(state, (nexState) => {
    nexState.assetsList = action.payload;
  }))
  .handleAction(actions.setPoolsList, (state, action) => produce(state, (nexState) => {
    nexState.poolsList = action.payload;
    nexState.isLoading = false;
  }))
  .handleAction(actions.setTxStatus, (state, action) => produce(state, (nexState) => {
    nexState.tx_status = action.payload;
  }))
  .handleAction(actions.setTransactionStatus, (state, action) => produce(state, (nexState) => {
    nexState.statusTransaction = action.payload;
  }))
  .handleAction(actions.setPredict, (state, action) => produce(state, (nexState) => {
    nexState.predict = action.payload;
  }))
  .handleAction(actions.setCurrentPool, (state, action) => produce(state, (nexState) => {
    nexState.currentPool = action.payload;
  }))
  .handleAction(actions.setFilter, (state, action) => produce(state, (nexState) => {
    nexState.filter = action.payload;
  }))
  .handleAction(actions.setFeeFilter, (state, action) => produce(state, (nexState) => {
    nexState.feeFilter = action.payload;
  }))
  .handleAction(actions.setOptions, (state, action) => produce(state, (nexState) => {
    nexState.options = action.payload;
  }))
  .handleAction(actions.setFavorites, (state, action) => produce(state, (nexState) => {
    nexState.favorites = action.payload;
  }))
  .handleAction(actions.setFavoriteAssets, (state, action) => produce(state, (nexState) => {
    nexState.favoriteAssets = action.payload;
  }))
  .handleAction(actions.setCurrentLPToken, (state, action) => produce(state, (nexState) => {
    nexState.currentPool = action.payload;
  }))
  .handleAction(actions.setIsLoading, (state, action) => produce(state, (nexState) => {
    nexState.isLoading = action.payload;
  }))
  .handleAction(actions.setIsHeadless, (state, action) => produce(state, (nexState) => {
    nexState.isHeadless = action.payload;
  }))
  .handleAction(actions.setShaderRuntimeMap, (state, action) => produce(state, (nexState) => {
    nexState.shaderRuntimeMap = action.payload;
  }))
  .handleAction(actions.setRewardsState, (state, action) => produce(state, (nexState) => {
    nexState.rewards = { ...nexState.rewards, ...action.payload };
  }));
export { reducer as MainReducer };
