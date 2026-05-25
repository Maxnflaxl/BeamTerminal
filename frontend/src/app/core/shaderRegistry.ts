import { CID, CURRENT_NETWORK, NETWORK } from '@app/shared/constants';

export type ShaderFeature = 'amm' | 'accumulator';

export interface ShaderDescriptor {
  feature: ShaderFeature;
  cid: string;
  wasmPath: string;
}

export interface ShaderRuntimeConfig extends ShaderDescriptor {
  contractBytes: number[] | null;
}

export type ShaderRuntimeMap = Record<ShaderFeature, ShaderRuntimeConfig>;

const ACCUMULATOR_CID_MAINNET = 'ec160307c43bc3fc0c3a52d3e3d3dfd8101593e8cec7a907fc42c9f103aabbae';
const ACCUMULATOR_CID_DAPPNET = 'ae928370514fffe952ded36338b3a40326915ffa511b72c99f5e07aba2ee1ac3';

const ACCUMULATOR_CID = CURRENT_NETWORK === NETWORK.MAINNET
  ? ACCUMULATOR_CID_MAINNET
  : ACCUMULATOR_CID_DAPPNET;

const SHADER_REGISTRY: Record<ShaderFeature, ShaderDescriptor> = {
  amm: {
    feature: 'amm',
    cid: CID,
    wasmPath: './amm.wasm',
  },
  accumulator: {
    feature: 'accumulator',
    cid: ACCUMULATOR_CID,
    wasmPath: './dao-accumulator.wasm',
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
    accumulator: {
      ...SHADER_REGISTRY.accumulator,
      contractBytes: bytesByFeature.accumulator || null,
    },
  };
}
