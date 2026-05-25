import { call, take } from 'redux-saga/effects';

import { eventChannel, END } from 'redux-saga';
import { setSystemState, setIsLoaded } from '@app/shared/store/actions';
import { actions as mainActions } from '@app/containers/Pools/store/index';
import {
  buildShaderRuntimeMap,
  getShaderDescriptor,
  getShaderFeatures,
  ShaderFeature,
} from '@app/core/shaderRegistry';

import connector from '@core/connector';
import { setTxStatus } from '@app/containers/Pools/store/actions';
import { isInsideWallet } from '@core/walletEnv';
import store from '../../../index';

const shaderBytesByFeature: Partial<Record<ShaderFeature, number[]>> = {};

async function warmupShaderCache(): Promise<void> {
  await Promise.all(
    getShaderFeatures().map(async (feature) => {
      const descriptor = getShaderDescriptor(feature);
      const bytes = await connector.downloadShader(descriptor.wasmPath);
      shaderBytesByFeature[feature] = Array.from(bytes);
    }),
  );
}

export async function start() {
  await warmupShaderCache();
  await connector.callApi('ev_subunsub', {
    ev_txs_changed: true,
    ev_system_state: true,
  });

  store.dispatch(mainActions.loadAppParams.request(buildShaderRuntimeMap(shaderBytesByFeature)));
  store.dispatch(mainActions.loadPoolsList.request(null, null));
}

export function remoteEventChannel() {
  return eventChannel((emitter) => {
    connector.on('apiEvent', (response: any) => {
      if (response) {
        emitter(response);
      }
    });

    // Render the screener immediately. Wallet-dependent flows (pools, swaps)
    // initialize their own data once a connection exists.
    // Deferred to a microtask: the channel callback runs synchronously inside
    // configureStore(), before index.tsx's `export default store` is assigned,
    // so a synchronous access would hit a TDZ on the entry's default export.
    queueMicrotask(() => store.dispatch(setIsLoaded(true)));

    // Auto-connect only when the page is loaded inside a BEAM wallet
    // (desktop Qt WebEngine, mobile WebView with window.BEAM, etc.). In a
    // plain browser the wallet stays disconnected until the user triggers a
    // wallet-requiring action.
    if (isInsideWallet()) {
      connector.connect()
        .then(() => start())
        .catch(() => {});
    }

    return () => emitter(END);
  });
}

function* sharedSaga() {
  const remoteChannel = yield call(remoteEventChannel);

  while (true) {
    try {
      const payload: any = yield take(remoteChannel);
      switch (payload.id) {
        case 'ev_system_state':
          store.dispatch(setSystemState(payload.result));
          break;

        case 'ev_txs_changed':
          store.dispatch(setTxStatus(payload.result));
          store.dispatch(mainActions.loadAppParams.request(buildShaderRuntimeMap(shaderBytesByFeature)));
          break;
        default:
          break;
      }
    } catch (err) {
      remoteChannel.close();
    }
  }
}

export default sharedSaga;
