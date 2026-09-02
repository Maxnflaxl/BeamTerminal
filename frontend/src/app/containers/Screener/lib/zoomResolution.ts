export type ZoomRes = '1m' | '1h' | '1d' | '1M';
export const MAX_POINTS = 2000;
export const TILE_BUCKETS = 256;

const FULL: ZoomRes[] = ['1m', '1h', '1d'];
const DAILY: ZoomRes[] = ['1d'];
// The bridge series are indexed from daily rollups and go back over three years,
// so a month rung is the only coarser view worth offering — and the only chart
// family the server buckets monthly.
const MONTHLY: ZoomRes[] = ['1M', '1d'];
export const LADDERS: Record<string, ZoomRes[]> = {
  price: FULL,
  tvl: FULL,
  hashrate: FULL,
  difficulty: FULL,
  blockTime: FULL,
  coinbase: FULL,
  dexVolume: FULL,
  assets: FULL,
  transactionsDaily: FULL,
  transactionsTotal: FULL,
  txosTotal: FULL,
  utxosTotal: FULL,
  sizeTotal: FULL,
  archiveTotal: FULL,
  shieldedIns: FULL,
  shieldedInsTotal: FULL,
  shieldedOuts: FULL,
  shieldedOutsTotal: FULL,
  contractsTotal: FULL,
  feesDaily: FULL,
  feesTotal: FULL,
  callsDaily: FULL,
  callsTotal: FULL,
  beamVol: DAILY,
  dexVol: DAILY,
  dexVolumeCumulative: DAILY,
  blackhole: DAILY,
  poolsCreated: DAILY,
  poolsClosed: DAILY,
  bridgeTransfers: MONTHLY,
  bridgeTransfersTotal: MONTHLY,
  bridgeFees: MONTHLY,
  bridgeFeesTotal: MONTHLY,
  bridgeTvl: MONTHLY,
  bridgeTvlByAsset: MONTHLY,
};
