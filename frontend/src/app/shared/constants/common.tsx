export const REG_AMOUNT = /^(?!0\d)(\d+)(\.)?(\d{0,8})?$/;

export enum NETWORK {
  MAINNET = 'MAINNET',
  DAPPNET = 'DAPPNET',
}
// Public explorer-node HTTP API (no trailing slash — callers append /path).
export const EXPLORER_API = 'https://explorer.0xmx.net/api';

const CID_MAINNET = '729fe098d9fd2b57705db1a05a74103dd4b891f535aef2ae69b47bcfdeef9cbf';
const CID_DAPPNET = '4e0a28b2b2a83b811ad17ba8228b0645dbce2969fd453a68fbc0b60bc8860e02';
// export const CURRENT_NETWORK: string = NETWORK.DAPPNET
export const CURRENT_NETWORK = NETWORK.MAINNET;
export const BEAM_ID = 0;

export const CID = CURRENT_NETWORK === NETWORK.MAINNET ? CID_MAINNET : CID_DAPPNET;
export const BEAMX_ID = CURRENT_NETWORK === NETWORK.MAINNET ? 7 : 3;
export const NPH_ID = CURRENT_NETWORK === NETWORK.MAINNET ? 47 : 357;

export const ASSET_BEAM = {
  N: 'Beam Coin',
  SN: 'BEAM',
  UN: 'Beam',
  NTHUN: 'Groth',
};
