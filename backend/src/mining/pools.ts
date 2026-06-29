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
}

export const POOLS: PoolDescriptor[] = [
  { id: '2miners',        name: '2Miners',        website: 'https://beam.2miners.com',        baseUrl: 'https://beam.2miners.com',        adapter: 'open-eth',        payoutScheme: 'PPLNS' },
  { id: '2miners-solo',   name: '2Miners (Solo)', website: 'https://solo-beam.2miners.com',   baseUrl: 'https://solo-beam.2miners.com',   adapter: 'open-eth',        payoutScheme: 'SOLO' },
  { id: 'herominers',     name: 'HeroMiners',     website: 'https://beam.herominers.com',      baseUrl: 'https://beam.herominers.com',      adapter: 'cryptonote-node', payoutScheme: 'PROP' },
  { id: 'leafpool',       name: 'LeafPool',       website: 'https://beam.leafpool.com',        baseUrl: 'https://beam.leafpool.com',        adapter: 'cryptonote-node', payoutScheme: 'PPLNT' },
  { id: 'sunpool',        name: 'SunPool',        website: 'https://beam.sunpool.top',         baseUrl: 'https://beam.sunpool.top',         adapter: 'sunpool',         payoutScheme: 'PPLNS' },
  { id: 'acepool',        name: 'AcePool',        website: 'https://beam.acepool.top',         baseUrl: 'https://beam.acepool.top',         adapter: 'acepool',         payoutScheme: 'PPLNS' },
  { id: 'cedric-crispin', name: 'Cedric Crispin', website: 'https://beam.cedric-crispin.com',  baseUrl: 'https://beam.cedric-crispin.com',  adapter: 'cedric',          payoutScheme: 'PPLNS' },
];
