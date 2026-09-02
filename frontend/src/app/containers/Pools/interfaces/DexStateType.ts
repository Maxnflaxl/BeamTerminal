import { IAsset } from '@core/types';
import { ShaderRuntimeMap } from '@app/core/shaderRegistry';

export interface DexStateType {
  assetsList: IAsset[];
  shaderRuntimeMap: ShaderRuntimeMap | null;
}
