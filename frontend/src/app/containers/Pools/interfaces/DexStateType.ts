import {
  IAsset, IOptions, IPoolCard, IPredict, ITxStatus, KindProcent,
} from '@core/types';
import { ShaderRuntimeMap } from '@app/core/shaderRegistry';

export interface AccumulatorRewardsState {
  isAvailable: boolean;
  isLoading: boolean;
  error: string | null;
  lpTokenBalance: number;
  estimatedReward: number;
  locks: any[];
  lockOptions: IOptions[];
}

export interface DexStateType {
  assetsList: IAsset[];
  poolsList: IPoolCard[];
  tx_status: ITxStatus[] | null;
  statusTransaction: number | null;
  predict: IPredict;
  currentPool: IPoolCard;
  filter: string;
  feeFilter: KindProcent | null;
  options: IOptions[];
  favorites: IPoolCard[];
  favoriteAssets: number[];
  currentLPToken: IPoolCard;
  isLoading: boolean;
  isHeadless: boolean;
  shaderRuntimeMap: ShaderRuntimeMap | null;
  rewards: AccumulatorRewardsState;
}
