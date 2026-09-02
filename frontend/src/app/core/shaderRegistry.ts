import { CID } from '@app/shared/constants';

export type ShaderFeature = 'amm';

export interface ShaderDescriptor {
  feature: ShaderFeature;
  cid: string;
  wasmPath: string;
}

export interface ShaderRuntimeConfig extends ShaderDescriptor {
  contractBytes: number[] | null;
}

export type ShaderRuntimeMap = Record<ShaderFeature, ShaderRuntimeConfig>;

const SHADER_REGISTRY: Record<ShaderFeature, ShaderDescriptor> = {
  amm: {
    feature: 'amm',
    cid: CID,
    wasmPath: './amm.wasm',
  },
};

export function getShaderDescriptor(feature: ShaderFeature): ShaderDescriptor {
  return SHADER_REGISTRY[feature];
}

export function getShaderFeatures(): ShaderFeature[] {
  return Object.keys(SHADER_REGISTRY) as ShaderFeature[];
}

export function buildShaderRuntimeMap(bytesByFeature: Partial<Record<ShaderFeature, number[]>>): ShaderRuntimeMap {
  return {
    amm: {
      ...SHADER_REGISTRY.amm,
      contractBytes: bytesByFeature.amm || null,
    },
  };
}
