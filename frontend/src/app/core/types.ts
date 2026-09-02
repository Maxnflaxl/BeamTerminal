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
export interface ICreatePool {
  aid1: number;
  aid2: number;
  kind: number;
}
export interface IAddLiquidity extends ICreatePool {
  // Groth amounts. Accept exact integer strings (see format.toGrothsStr) so
  // large tx amounts aren't truncated by JS-number precision.
  val1: number | string;
  val2: number | string;
  bPredictOnly: number;
}
export interface ITrade extends ICreatePool {
  val1_buy: number;
  val2_pay: number;
  bPredictOnly?: number;
}

export interface IWithdraw extends ICreatePool {
  ctl: number | string;
  bPredictOnly?: number;
}
