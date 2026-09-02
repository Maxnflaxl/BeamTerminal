import { createAction, createAsyncAction } from 'typesafe-actions';
import { IAsset } from '@core/types';
import { ShaderRuntimeMap } from '@app/core/shaderRegistry';
import { MainActionsTypes } from '@app/containers/Pools/store/constants';

export const setAssetsList = createAction(MainActionsTypes.SET_ASSETS_LIST)<IAsset[]>();

export const loadAppParams = createAsyncAction(
  MainActionsTypes.LOAD_PARAMS,
  MainActionsTypes.LOAD_PARAMS_SUCCESS,
  MainActionsTypes.LOAD_PARAMS_FAILURE,
)<ShaderRuntimeMap, any>();

export const setShaderRuntimeMap = createAction(MainActionsTypes.SET_SHADER_RUNTIME_MAP)<ShaderRuntimeMap>();
