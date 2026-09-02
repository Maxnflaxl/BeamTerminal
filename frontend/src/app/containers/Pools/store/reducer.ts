import { DexStateType } from '@app/containers/Pools/interfaces/DexStateType';
import { ActionType, createReducer } from 'typesafe-actions';
import produce from 'immer';
import * as actions from './actions';

type Action = ActionType<typeof actions>;

const initialState: DexStateType = {
  assetsList: [],
  shaderRuntimeMap: null,
};

const reducer = createReducer<DexStateType, Action>(initialState)
  .handleAction(actions.setAssetsList, (state, action) =>
    produce(state, (nexState) => {
      nexState.assetsList = action.payload;
    }),
  )
  .handleAction(actions.setShaderRuntimeMap, (state, action) =>
    produce(state, (nexState) => {
      nexState.shaderRuntimeMap = action.payload;
    }),
  );

export { reducer as MainReducer };
