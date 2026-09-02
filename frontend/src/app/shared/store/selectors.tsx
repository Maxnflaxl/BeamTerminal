import { createSelector } from 'reselect';

import { AppState } from '../interface';

const selectShared = (state: AppState) => state.shared;

const routerLinkSelector = createSelector(selectShared, (state) => state.routerLink);
const isLoadedSelector = createSelector(selectShared, (state) => state.isLoaded);

export const selectRouterLink = () => routerLinkSelector;
export const selectIsLoaded = () => isLoadedSelector;
