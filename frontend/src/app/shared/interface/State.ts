import { SharedStateType } from '@app/shared/interface/SharedStateType';
import { DexStateType } from '@app/containers/Pools/interfaces/DexStateType';

export interface AppState {
  shared: SharedStateType;
  main: DexStateType;
}
