import { createSelector } from 'reselect';
import { AppState } from '@app/shared/interface';

const selectMain = (state: AppState) => state.main;

const assetsListSelector = createSelector(selectMain, (state) => state.assetsList);
const poolsListSelector = createSelector(selectMain, (state) => state.poolsList);
const txStatusSelector = createSelector(selectMain, (state) => state.statusTransaction);
const predictSelector = createSelector(selectMain, (state) => state.predict);
const currentPoolSelector = createSelector(selectMain, (state) => state.currentPool);
const filterSelector = createSelector(selectMain, (state) => state.filter);
const feeFilterSelector = createSelector(selectMain, (state) => state.feeFilter);
const optionsSelector = createSelector(selectMain, (state) => state.options);
const favoritesSelector = createSelector(selectMain, (state) => state.favorites);
const favoriteAssetsSelector = createSelector(selectMain, (state) => state.favoriteAssets);
const currentLpTokenSelector = createSelector(selectMain, (state) => state.currentLPToken);
const isLoadingSelector = createSelector(selectMain, (state) => state.isLoading);
const isHeadlessSelector = createSelector(selectMain, (state) => state.isHeadless);
const shaderRuntimeMapSelector = createSelector(selectMain, (state) => state.shaderRuntimeMap);
const rewardsSelector = createSelector(selectMain, (state) => state.rewards);

// Keep function signatures for backward compatibility while reusing stable selectors.
export const selectAssetsList = () => assetsListSelector;
export const selectPoolsList = () => poolsListSelector;
export const selectTxStatus = () => txStatusSelector;
export const selectPredirect = () => predictSelector;
export const selectCurrentPool = () => currentPoolSelector;
export const selectFilter = () => filterSelector;
export const selectFeeFilter = () => feeFilterSelector;
export const selectOptions = () => optionsSelector;
export const selectFavorites = () => favoritesSelector;
export const selectFavoriteAssets = () => favoriteAssetsSelector;
export const selectCurrentLPToken = () => currentLpTokenSelector;
export const selectIsLoading = () => isLoadingSelector;
export const selectIsHeadless = () => isHeadlessSelector;
export const selectShaderRuntimeMap = () => shaderRuntimeMapSelector;
export const selectRewards = () => rewardsSelector;
