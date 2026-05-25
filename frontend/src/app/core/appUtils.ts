import {
  IAsset, IMetadataPairs, IOptions, IPoolCard, IPredict, ITxStatus, Kind, KindProcent,
} from '@core/types';
import { ASSET_BEAM, GROTHS_IN_BEAM } from '@app/shared/constants';
import { ensureConnected } from '@core/walletEnv';
import { toast } from 'react-toastify';
import { actions as mainActions } from '@app/containers/Pools/store';
import store from '../../index';

const LENGTH_MAX = 6;

export function parseMetadata(metadata) {
  // Strip the leading "STD:" prefix instead of shifting the first segment —
  // the previous shift() dropped the first real key (e.g. SCH_VER=1).
  const body = metadata.startsWith('STD:') ? metadata.slice(4) : metadata;
  return body.split(';').reduce((accumulator, segment) => {
    if (!segment) return accumulator;
    const data = segment.split(/=(.*)/s);
    if (!data[0]) return accumulator;
    return { ...accumulator, [data[0]]: data[1] };
  }, {});
}

export function truncate(value: string, len = LENGTH_MAX): string {
  if (!value) {
    return '';
  }

  if (value.length <= len) {
    return value;
  }

  return `${value.slice(0, len)}…`;
}

/** Short ticker from STD metadata (e.g. SN=TQR), else UN / N. */
export function assetShortLabel(m: IMetadataPairs | undefined): string {
  if (!m) return '';
  return (m.SN || m.UN || m.N || '').trim();
}

export function getOptions(assets: IAsset[]) {
  const options = [
    {
      value: 0,
      label: 'BEAM',
    },
  ];
  assets.forEach((item) => {
    options.push({ value: item.asset_id, label: `${truncate(assetShortLabel(item.parsedMetadata))}` });
  });
  return options;
}
export function numFormatter(num) {
  if (num > 999 && num < 1000000) {
    return `${parseFloat((num / 1000).toFixed(2))}K`;
  }
  if (num >= 1000000) {
    return `${parseFloat((num / 1000000).toFixed(2))}M`;
  }
  if (num <= 999) {
    return parseFloat(num.toFixed(2));
  }
  return num;
}

export function formatNumber(num: string | number): string {
  const parsedNum = typeof num === 'number' ? num : Number(num);
  return parsedNum.toLocaleString('en-US', { maximumFractionDigits: 8 });
}

/** Maps selection indices after thousand-separator grouping (see TradePool formatUserInput). */
function displayIndexForNormalizedPrefix(nextDisplay: string, normPrefix: string): number {
  if (!normPrefix) return 0;
  let acc = '';
  for (let pos = 0; pos <= nextDisplay.length; pos += 1) {
    if (acc === normPrefix) return pos;
    if (pos < nextDisplay.length) {
      const ch = nextDisplay[pos];
      if (ch !== ',') acc += ch;
    }
  }
  return nextDisplay.length;
}

export function caretAfterGroupingFormat(
  prevDisplay: string,
  nextDisplay: string,
  caretStart: number | null,
  caretEnd: number | null,
): { start: number; end: number } {
  const n = prevDisplay.length;
  const s = Math.min(Math.max(caretStart ?? 0, 0), n);
  const e = Math.min(Math.max(caretEnd ?? s, 0), n);
  const normStart = prevDisplay.slice(0, s).replace(/,/g, '');
  const normEnd = prevDisplay.slice(0, e).replace(/,/g, '');
  return {
    start: displayIndexForNormalizedPrefix(nextDisplay, normStart),
    end: displayIndexForNormalizedPrefix(nextDisplay, normEnd),
  };
}

const KIND_TO_PROCENT: Partial<Record<Kind, KindProcent>> = {
  [Kind.Low]: KindProcent.Low,
  [Kind.Mid]: KindProcent.Mid,
  [Kind.High]: KindProcent.High,
};

export const getPoolKind = (kind: number): KindProcent | null => KIND_TO_PROCENT[kind as Kind] ?? null;

export const onFeeFilter = (data: IPoolCard[], feeFilter: KindProcent | null): IPoolCard[] => {
  if (feeFilter === null) return data;
  return data.filter((pool) => getPoolKind(pool.kind) === feeFilter);
};

export const parsePoolMetadata = (poolCard, aid1, aid2, assetList: IAsset[]) => {
  let data = poolCard;
  if (aid1 === 0) {
    data = { ...data, metadata1: ASSET_BEAM };
  } else {
    const firstAsset = assetList.find((item) => aid1 === item.asset_id);
    if (firstAsset) {
      data = { ...data, metadata1: firstAsset.parsedMetadata };
    }
  }
  if (aid2 === 0) {
    data = { ...data, metadata2: ASSET_BEAM };
  } else {
    const secondAsset = assetList.find((item) => aid2 === item.asset_id);
    if (secondAsset) {
      data = { ...data, metadata2: secondAsset.parsedMetadata };
    }
  }
  return data;
};

export function fromGroths(value: number): string | number {
  if (!value || value === 0) {
    return 0;
  }
  const sign = Number(value) < 0 ? '-' : '';
  const absValue = Math.abs(Number(value));
  const integerPart = Math.floor(absValue / GROTHS_IN_BEAM);
  const fractionalRaw = Math.floor(absValue % GROTHS_IN_BEAM)
    .toString()
    .padStart(8, '0')
    .replace(/0+$/, '');
  return `${sign}${integerPart}${fractionalRaw ? `.${fractionalRaw}` : ''}`;
}

export function toGroths(value: number): number {
  const val = Number(parseFloat((value * GROTHS_IN_BEAM).toString()).toPrecision(12));
  return value > 0 ? Math.floor(val) : 0;
}

export function parseIntToNum(value: string): number {
  const val = parseInt(value);
  return parseInt(value) > 0 ? Math.floor(val) : 0;
}

export function checkTxStatus(txId: string, txList: ITxStatus[]) {
  let status;
  // TODO: type rr
  // @ts-ignore
  txList.txs.find((item) => {
    if (item.txId === txId) {
      status = item.status;
    }
    return status;
  });
  return status;
}

export function setDataRequest(data) {
  return { ...data, bPredictOnly: 0 };
}
export function onFilter(data: IPoolCard[], filter = 'all', favorite: IPoolCard[]) {
  switch (filter) {
    case 'all': {
      return [...data].sort((a, b) => b.ctl - a.ctl);
    }
    case 'created': {
      return data.filter((el) => el.creator);
    }
    case 'liquid': {
      return data.filter((el) => el.ctl);
    }
    case 'empty': {
      return data.filter((el) => !el.ctl);
    }
    case 'fav': {
      return data.filter((item) => favorite.some(
        (item2) => item.aid1 === item2.aid1 && item.aid2 === item2.aid2 && item.kind === item2.kind,
      ));
    }
    default:
      return [...data].sort((a, b) => b.ctl - a.ctl);
  }
}

export const emptyPredict = (data: IPredict, amount: string | number): boolean => !data || !amount || amount === '0';

export const onPredictValue = (value, swap: boolean, predict: IPredict) => {
  if (!predict || value.value === 0) {
    return 0;
  }
  if (swap) {
    return fromGroths(predict.tok1);
  }
  return fromGroths(predict.tok2);
};
export const getFilterPools = (value: IOptions, data: IPoolCard[]): IPoolCard[] => {
  let newList = [];
  if (value !== null && value !== undefined) {
    newList = data.filter((el) => el.aid1 === value.value || el.aid2 === value.value || el['lp-token'] === value.value);
    return newList.length === 0 ? null : newList;
  }
  return data;
};

export const getTotalFee = (daoFee: number, poolFee: number) => daoFee + poolFee;
export function convertLowAmount(explicitNum) {
  if (explicitNum !== undefined) {
    const data = explicitNum.split(/[eE]/);
    if (data.length === 1) {
      return data[0];
    }
    let z = '';
    const sign = explicitNum.slice(0, 1) === '-' ? '-' : '';
    const str = data[0].replace('.', '');
    let mag = Number(data[1]) + 1;
    if (mag <= 0) {
      z = `${sign}0.`;
      while (!(mag >= 0)) {
        z += '0';
        mag += 1;
      }
      const num = z + str.replace(/^-/, '');
      if (explicitNum) {
        return parseFloat(num);
      }
      return num;
    }
    if (str.length <= mag) {
      mag -= str.length;
      while (!(mag <= 0)) {
        z += 0;
        mag -= 1;
      }
      const num = str + z;
      if (explicitNum) {
        return parseFloat(num);
      }
      return num;
    }
    const leader = parseFloat(data[0]);
    const multiplier = 10 ** parseInt(data[1], 10);
    return leader * multiplier;
  }
  return 0;
}

export function isInArray(card, arr: IPoolCard[]) {
  if (card && arr) {
    if (card.isArray) {
      card.map((item: IPoolCard) => item.aid1 === card.aid1 && item.aid2 === card.aid2 && item.kind === card.kind);
    } else {
      if (arr.some((e) => e.aid1 === card.aid1 && e.aid2 === card.aid2 && e.kind === card.kind)) {
        return true;
      }
      return false;
    }
    return false;
  }
  return false;
}

export function getLPToken(poolCard: IPoolCard, assets: IAsset[]): IAsset {
  let currentLpToken = null;
  if (poolCard && assets) {
    currentLpToken = assets.find((el) => el.aid === poolCard['lp-token']);
    return currentLpToken;
  }
  return currentLpToken;
}

export function setStorage() {
  const fav = JSON.parse(localStorage.getItem('favorites'));
  if (!fav) {
    localStorage.setItem('favorites', JSON.stringify([]));
  }
  const favAssets = JSON.parse(localStorage.getItem('favoriteAssets'));
  if (!favAssets) {
    localStorage.setItem('favoriteAssets', JSON.stringify([]));
  }
  return fav;
}

export async function onSwitchToApi() {
  const ok = await ensureConnected();
  if (ok) {
    store.dispatch(mainActions.setIsHeadless(false));
    toast('Your wallet is connected');
  } else {
    toast('Sorry, wallet not connected');
  }
}
