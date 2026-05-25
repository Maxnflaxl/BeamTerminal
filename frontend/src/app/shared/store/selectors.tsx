import { createSelector } from 'reselect';

import { AppState } from '../interface';

const selectShared = (state: AppState) => state.shared;

const routerLinkSelector = createSelector(selectShared, (state) => state.routerLink);
const errorMessageSelector = createSelector(selectShared, (state) => state.errorMessage);
const systemStateSelector = createSelector(selectShared, (state) => state.systemState);
const isLoadedSelector = createSelector(selectShared, (state) => state.isLoaded);

export const selectRouterLink = () => routerLinkSelector;
export const selectErrorMessage = () => errorMessageSelector;
export const selectSystemState = () => systemStateSelector;
export const selectIsLoaded = () => isLoadedSelector;
