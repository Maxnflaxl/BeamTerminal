import { call, put, takeLatest } from 'redux-saga/effects';
import { IAsset } from '@core/types';
import { LoadAssetsList } from '@core/api';
import { parseMetadata } from '@core/appUtils';
import * as mainActions from '@app/containers/Pools/store/actions';
import { toast } from 'react-toastify';
import { actions as Shared } from '@app/shared/store/index';
import { actions } from '.';

export function* loadParamsSaga(action: ReturnType<typeof actions.loadAppParams.request>): Generator {
  try {
    yield put(mainActions.setShaderRuntimeMap(action.payload));
    let assetsList: IAsset[] = [];
    try {
      assetsList = (yield call(LoadAssetsList)) as IAsset[];
    } catch (_error) {
      // The wallet asset list is a best-effort enrichment for icons; an empty
      // catalogue must not block the app from reporting itself loaded.
      assetsList = [];
    }
    assetsList.forEach((asset) => {
      asset.parsedMetadata = parseMetadata(asset.metadata);
    });
    yield put(mainActions.setAssetsList(assetsList));
    yield put(Shared.setIsLoaded(true));
  } catch (e) {
    // @ts-ignore
    yield put(mainActions.loadAppParams.failure(e));
    yield put(Shared.setIsLoaded(true));
    toast(e.error);
  }
}

function* mainSaga() {
  yield takeLatest(mainActions.loadAppParams.request, loadParamsSaga);
}

export default mainSaga;
