import { createSelector } from 'reselect';
import { AppState } from '@app/shared/interface';

const selectMain = (state: AppState) => state.main;

const assetsListSelector = createSelector(selectMain, (state) => state.assetsList);
const shaderRuntimeMapSelector = createSelector(selectMain, (state) => state.shaderRuntimeMap);

// Keep function signatures for backward compatibility while reusing stable selectors.
export const selectAssetsList = () => assetsListSelector;
export const selectShaderRuntimeMap = () => shaderRuntimeMapSelector;
