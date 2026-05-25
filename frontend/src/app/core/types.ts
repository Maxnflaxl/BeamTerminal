export type Pallete = 'green' | 'ghost' | 'purple' | 'blue' | 'red' | 'white' | 'vote-red';

export type ButtonVariant =
  | 'regular'
  | 'ghost'
  | 'ghostBordered'
  | 'block'
  | 'link'
  | 'icon'
  | 'control'
  | 'trade'
  | 'approve'
  | 'cancel'
  | 'withdraw';

export enum Kind {
  Low = 0,
  Mid = 1,
  High = 2,
}
export enum KindProcent {
  Low = '0.05%',
  Mid = '0.3%',
  High = '1%',
}

export enum TxStatus {
  Pending = 0,
  InProgress = 1,
  Canceled = 2,
  Completed = 3,
  Failed = 4,
  Registering = 5,
}
export interface IMetadataPairs {
  N: string;
  NTHUN?: string;
  SCH_VER?: string;
  SN: string;
  UN?: string;
  OPT_COLOR?: string;
}
export interface IAsset {
  asset_id?: number;
  aid?: number;
  metadata: string;
  emission?: number;
  emission_str?: string;
  owner_pk: string;
  parsedMetadata: IMetadataPairs;
}
export interface IPoolCard {
  aid1: number;
  aid2: number;
  ctl: number;
  k1_2: string;
  k1_ctl: string;
  k2_1: string;
  k2_ctl: string;
  kind: number;
  lp_token: number;
  tok1: number;
  tok2: number;
  metadata1?: IMetadataPairs;
  metadata2?: IMetadataPairs;
  creator?: number;
}
export interface ICreatePool {
  aid1: number;
  aid2: number;
  kind: number;
}
export interface IAddLiquidity extends ICreatePool {
  val1: number;
  val2: number;
  bPredictOnly: number;
}
export interface ITrade extends ICreatePool {
  val1_buy: number;
  val2_pay: number;
  bPredictOnly?: number;
}

export interface IWithdraw extends ICreatePool {
  ctl: number;
  bPredictOnly?: number;
}

export interface ITsx {
  txId: string;
  asset_id: number;
  comment: string;
  fee: number;
  kernel: string;
  receiver: string;
  sender: string;
  status: number;
  status_string: string;
  tx_type: number;
  tx_type_string: string;
  failure_reason: string;
  value: number;
  create_time: number;
  income: boolean;
  rates: any[];
  sender_identity: string;
  receiver_identity: string;
  token: string;
}

export interface ITxStatus {
  change: number;
  change_str: string;
  txs: ITsx[];
}

export interface ITxId {
  txid: string;
}
export interface IPredict {
  buy?: number;
  fee_dao?: number;
  fee_pool?: number;
  pay?: number;
  pay_raw?: number;
  ctl?: number;
  tok1?: number;
  tok2?: number;
}
export interface ITxResult {
  txid?: string;
  res?: IPredict;
}
export interface IError {
  answer: {
    id: string;
    jsonrpc: string;
    result: {
      output: any;
      txid: string;
    };
  };
  error: string;
}

export interface IOptions {
  value: number;
  label: string;
}

export interface IAccumulatorLockOption {
  value: number;
  label: string;
}

export interface IAccumulatorUserLock {
  lpToken?: number;
  ['unlock-height']?: number;
  ['avail-BeamX']?: number;
}

export interface IAccumulatorRewardsState {
  isAvailable: boolean;
  isLoading: boolean;
  error: string | null;
  lpTokenBalance: number;
  estimatedReward: number;
  lockOptions: IAccumulatorLockOption[];
  locks: IAccumulatorUserLock[];
}
