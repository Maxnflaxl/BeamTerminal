import { all, fork } from 'redux-saga/effects';
import sharedSaga from '@app/shared/store/saga';
import mainSaga from '@app/containers/Pools/store/saga';

const allSagas = [sharedSaga, mainSaga];

export default function* appSagas() {
  yield all(allSagas.map(fork));
}
