// Static registry of BEAM mining pools we poll. There is no BEAM-wide pool API;
// each pool exposes its own stats endpoint. `adapter` selects the normalizer in
// ./adapters.ts. Live numbers (hashrate/miners/blocks) come from the adapter;
// payoutScheme is static metadata pools don't reliably expose via API.
// Verified against data.miningpoolstats.stream/data/beam.js on 2026-06-29.

export type AdapterKind =
  | 'open-eth'         // open-ethereum-pool family (2miners)
  | 'cryptonote-node'  // cryptonote-nodejs-pool family (herominers, leafpool)
  | 'sunpool'
  | 'acepool'
  | 'cedric';

export interface PoolDescriptor {
  id: string;
  name: string;
  website: string;
  baseUrl: string;     // origin used to build the stats API URL
  adapter: AdapterKind;
  payoutScheme: string;
  // Known pool fee (%). Static fallback for the UI when a pool's API does not
  // expose its fee (e.g. open-ethereum-pool /api/stats has no config block).
  // Live fee from the snapshot takes precedence when present.
  fee: number;
}

export const POOLS: PoolDescriptor[] = [
  { id: '2miners',        name: '2Miners',        website: 'https://beam.2miners.com',        baseUrl: 'https://beam.2miners.com',        adapter: 'open-eth',        payoutScheme: 'PPLNS', fee: 1 },
  { id: '2miners-solo',   name: '2Miners (Solo)', website: 'https://solo-beam.2miners.com',   baseUrl: 'https://solo-beam.2miners.com',   adapter: 'open-eth',        payoutScheme: 'SOLO',  fee: 1.5 },
  { id: 'herominers',     name: 'HeroMiners',     website: 'https://beam.herominers.com',      baseUrl: 'https://beam.herominers.com',      adapter: 'cryptonote-node', payoutScheme: 'PROP',  fee: 0.9 },
  { id: 'leafpool',       name: 'LeafPool',       website: 'https://beam.leafpool.com',        baseUrl: 'https://beam.leafpool.com',        adapter: 'cryptonote-node', payoutScheme: 'PPLNT', fee: 0.5 },
  { id: 'sunpool',        name: 'SunPool',        website: 'https://beam.sunpool.top',         baseUrl: 'https://beam.sunpool.top',         adapter: 'sunpool',         payoutScheme: 'PPLNS', fee: 0 },
  { id: 'acepool',        name: 'AcePool',        website: 'https://beam.acepool.top',         baseUrl: 'https://beam.acepool.top',         adapter: 'acepool',         payoutScheme: 'PPLNS', fee: 0 },
  { id: 'cedric-crispin', name: 'Cedric Crispin', website: 'https://beam.cedric-crispin.com',  baseUrl: 'https://beam.cedric-crispin.com',  adapter: 'cedric',          payoutScheme: 'PPLNS', fee: 0.1 },
];
