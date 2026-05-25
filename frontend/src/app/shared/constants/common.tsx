import { Kind } from '@core/types';

export const GROTHS_IN_BEAM = 100_000_000;
export const REG_AMOUNT = /^(?!0\d)(\d+)(\.)?(\d{0,8})?$/;

export enum NETWORK {
  MAINNET = 'MAINNET',
  DAPPNET = 'DAPPNET',
}
const CID_MAINNET = '729fe098d9fd2b57705db1a05a74103dd4b891f535aef2ae69b47bcfdeef9cbf';
const CID_DAPPNET = '4e0a28b2b2a83b811ad17ba8228b0645dbce2969fd453a68fbc0b60bc8860e02';
// export const CURRENT_NETWORK: string = NETWORK.DAPPNET
export const CURRENT_NETWORK = NETWORK.MAINNET;
export const BEAM_ID = 0;
export const REWARDS_DEV_MODE = false;

export const CID = CURRENT_NETWORK === NETWORK.MAINNET ? CID_MAINNET : CID_DAPPNET;
export const BEAMX_ID = CURRENT_NETWORK === NETWORK.MAINNET ? 7 : 3;
export const NPH_ID = CURRENT_NETWORK === NETWORK.MAINNET ? 47 : 357;
export const ULR_WEB_WALLET = 'https://chrome.google.com/webstore/detail/beam-web-wallet/ilhaljfiglknggcoegeknjghdgampffk';

export const ASSET_BEAM = {
  N: 'Beam Coin',
  SN: 'BEAM',
  UN: 'Beam',
  NTHUN: 'Groth',
};

export const kindSelect = [
  { value: Kind.Low, label: '0.05%' },
  { value: Kind.Mid, label: '0.3%' },
  { value: Kind.High, label: '1%' },
];

export const SORT = [
  { name: 'All', value: 'all' },
  { name: 'Created', value: 'created' },
  { name: 'Liquid', value: 'liquid' },
  { name: 'Rewards', value: 'rewards' },
  { name: 'Empty', value: 'empty' },
  { name: 'Favorites', value: 'fav' },
];

const REWARDS_LP_TOKENS = [
  50, // BEAM/BEAMX
  60, // BEAM/NPH
];

export const poolHasRewards = (lpToken: number | string | null | undefined): boolean => {
  if (!REWARDS_DEV_MODE) return false;
  const normalized = Number(lpToken);
  if (!Number.isFinite(normalized)) return false;
  return REWARDS_LP_TOKENS.includes(normalized);
};

export const titleSections = {
  ADD_LIQUIDITY: 'input deposit asset',
  ADD_LIQUIDITY_SEND: 'send amount',
  TRADE_RECEIVE: 'receive amount',
  TRADE_SEND: 'send amount (estimated)',
  CREATE_FIRST: 'select first asset',
  CREATE_SECOND: 'select second asset',
  FEE: 'select fee tier',
};

export const placeHolder = {
  ASSETS: 'select asset',
  FEE: 'select fee tier',
  SEARCH: 'all assets',
};
