// Mirrors beam/core/block_crypt.cpp Rules::Emission and
// beam/core/treasury.cpp Treasury::CreatePlan (mainnet).

export const EXPLORER_API = 'https://explorer.0xmx.net/api/';

export const HALVING_MARKERS = [
  { height: 525601,  label: 'First halving' },
  { height: 2628001, label: 'Second halving' },
  { height: 4730401, label: 'Third halving' },
];

export const FORK_MARKERS = [
  { height: 321321,  label: 'First hard fork' },
  { height: 777777,  label: 'Second hard fork' },
  { height: 1280000, label: 'Third hard fork' },
  { height: 1820000, label: 'Fourth hard fork' },
  { height: 1920000, label: 'Fifth hard fork' },
  { height: 3928666, label: 'Sixth hard fork' },
];

// Notable mainnet blocks, mirrored from beam/explorer/htm/BeamExplorer.htm's
// `specialBlocks` (descriptions trimmed). Shared by the Block Explorer + Supply.
export interface SpecialBlock {
  block_list?: number[];
  block_range?: [number, number];
  title: string;
  description: string;
  links?: Array<[string, string]>;
}

export const specialBlocks: SpecialBlock[] = [
  {
    block_list: [0],
    title: 'Treasury',
    description: 'Beam emission is inspired by Bitcoin\'s, but with 1-minute blocks. First halving after 1 year, then every 4 years. Total supply 262,800,000 BEAM. For the first 5 years, 20% of block rewards went to a Treasury that the Beam Foundation used to repay investors and fund development. The Treasury is represented as a pseudo-block at height 0 containing pre-allocated UTXOs with maturity schedules.',
    links: [
      ['Beam emission schedule', 'https://medium.com/beam-mw/mimblewimble-emission-schedule-215551948259'],
      ['Beam Foundation', 'https://www.beam-foundation.org'],
    ],
  },
  {
    block_list: [1],
    title: 'Genesis block',
    description: 'Beam launched the first ever Mimblewimble-based confidential cryptocurrency on January 3rd 2019 (also the 10-year anniversary of the Bitcoin genesis block). No pre-mine, no ICO; the genesis block records the hash of Bitcoin block 556833 mined the same day.',
    links: [
      ['First Beam Medium post', 'https://medium.com/beam-mw/introducing-beam-f35096a923ec'],
      ['Mainnet launch notes', 'https://medium.com/beam-mw/mimblewimble-mainnet-release-notes-8766e49e241d'],
    ],
  },
  {
    block_list: [159, 160],
    title: 'The fastest blocks on Earth',
    description: 'About 90 minutes after the genesis block, blocks 159 and 160 were mined within the same second. Possible but unlikely under a Poisson distribution with 60s target.',
  },
  {
    block_range: [25709, 25820],
    title: 'Blockchain Stop Event',
    description: 'On January 21st 2019 the chain stopped at block 25709. A hotfix was released a few hours later. No blocks were produced for 2.5 hours, and no transactions (except coinbase) for 112 blocks. No funds were lost.',
    links: [['Postmortem analysis', 'https://medium.com/beam-mw/mimblewimble-blockchain-stop-event-postmortem-21012019-9a7ef38b2813']],
  },
  {
    block_list: [321321],
    title: 'First Hard-Fork',
    description: 'PoW algorithm updated from BeamHash I to BeamHash II.',
  },
  {
    block_list: [525600, 525601],
    title: 'First Halving',
    description: 'On January 5th 2020 the block reward was halved from 100 BEAM to 50 BEAM. Subsequent halvings are every 4 years.',
  },
  {
    block_list: [777777],
    title: 'Second Hard-Fork',
    description: 'PoW updated to BeamHash III. Confidential Assets activated. Lelantus-MW protocol enabled (offline transactions).',
  },
  {
    block_list: [778579],
    title: 'First Lelantus-MW transaction',
    description: 'First transaction routed through the Shielded Pool.',
  },
  {
    block_list: [778857],
    title: 'First input UTXO from a Shielded Pool',
    description: 'First time a Shielded Pool UTXO was spent as an input to a normal Mimblewimble transaction. The pool held only 8 UTXOs then, so the anonymity set was still small. Shielded outputs are never cut-through, so the anonymity set grows linearly as people use Lelantus transactions.',
  },
  {
    block_list: [780219],
    title: 'Creation of the first Confidential Asset',
    description: 'Asset id:1 minted. Later became the basis for Tico (id:9).',
  },
  {
    block_list: [1280000],
    title: 'Third Hard-Fork (and wallet v6.0)',
    description: 'Beam Virtual Machine (BVM) added; smart contracts ("shaders") become available, making Beam the first privacy coin with smart-contract capabilities.',
  },
  {
    block_list: [1280003],
    title: 'Deployment of the first Smart Contract',
    description: 'A simple faucet, deployed minutes after the third hard-fork.',
  },
  {
    block_list: [1464852],
    title: 'BeamX creation',
    description: 'Governance token of the BeamX DAO (asset id:7). All 100,000,000 units were minted at once by the DAO Core contract.',
  },
  {
    block_list: [1466501],
    title: 'Start of the first BeamX staking campaign',
    description: 'A first 3-month (131,400 blocks) campaign let users earn BeamX rewards by locking their BEAM. 1,000,000 BEAMX (1% of the total supply) were distributed. The DAO Core contract still holds BEAM that stakers never claimed back.',
    links: [
      ['First BeamX reward campaign', 'https://medium.com/@beam_privacy/heres-everything-you-need-to-know-to-prepare-for-beam-staking-108eef344f7d'],
      ['Details on the campaign', 'https://medium.com/beam-mw/beamers-hodlers-beam-staking-is-coming-513bd196af57'],
    ],
  },
  {
    block_list: [1820000],
    title: 'Fourth Hard-Fork (and wallet v7.0)',
    description: 'Added High-Frequency Transactions (HFTX) and IPFS storage integration on the wallet side.',
  },
  {
    block_list: [1920000],
    title: 'Fifth Hard-Fork (and wallet v7.1)',
    description: 'Confidential Asset issuance cost reduced from 3000 to 10 BEAM. Smart contracts can verify fork heights.',
  },
  {
    block_list: [2272779],
    title: 'Blockchain incident',
    description: 'Chain stopped producing blocks for 103 minutes due to a kernel sort issue. All pending transactions landed in block 2272781. No funds lost.',
  },
  {
    block_list: [2628000, 2628001],
    title: 'Second Halving & End of the 5-year treasury allocation',
    description: 'January 2024: block reward halved from 50 BEAM to 25 BEAM. Treasury allocation ended; 100% of block rewards now go to miners.',
  },
  {
    block_list: [3928666],
    title: 'Sixth Hard-Fork (emergency hard fork)',
    description: 'June 2026: emergency fork after responsible disclosure of a subtle vulnerability in Beam\'s Bulletproofs rangeproofs that had eluded multiple professional audits. Patched privately and rolled out with the main pools and exchanges before public disclosure. In theory it could have allowed creating coins and assets out of thin air, so a "lustration" process was proposed to verify supply integrity. The fork also improved concealment of Confidential Asset ids (every 64-id range now also includes id 0, i.e. BEAM itself).',
    links: [
      ['Blog post', 'https://beam.mw/blog/news/hardfork-six'],
      ['Release notes', 'https://github.com/BeamMW/beam/releases/tag/beam-7.5.14493'],
    ],
  },
];

const DROP0 = 1440 * 365;
const DROP1 = 1440 * 365 * 4;
export const EMIT_BASE = 80;
const TREASURY_BASE = EMIT_BASE / 4;
const MATURITY_STEP = Math.floor((1440 * 365) / 12);
const TREASURY_BURSTS = 12 * 5;

export interface Emission { rate: number; hEnd: number }

export function getEmissionEx(h: number, base: number): Emission {
  const b0 = Math.floor(base);
  if (!b0 || h < 1) return { rate: 0, hEnd: 0 };
  const hp = h - 1;
  if (hp < DROP0) return { rate: b0, hEnd: DROP0 + 1 };
  const n = 1 + Math.floor((hp - DROP0) / DROP1);
  if (n >= 53) return { rate: 0, hEnd: 9007199254740991 };
  const hEnd = DROP0 + n * DROP1 + 1;
  let b = b0;
  if (n >= 2) b += b >> 2;
  // eslint-disable-next-line no-bitwise
  return { rate: b >> n, hEnd };
}

export function getEmissionSumRange(hrMin: number, hrMax: number, base: number): number {
  if (hrMax < hrMin) return 0;
  let res = 0;
  let hPos = hrMin;
  while (true) {
    const { rate, hEnd } = getEmissionEx(hPos, base);
    if (!rate) break;
    if (hrMax < hEnd) { res += rate * (hrMax - hPos + 1); break; }
    res += rate * (hEnd - hPos);
    hPos = hEnd;
  }
  return res;
}

interface TreasuryBurst { height: number; val: number }

function buildTreasuryBurstTable(): TreasuryBurst[] {
  let hrMax = 0;
  const bursts: TreasuryBurst[] = [];
  for (let i = 0; i < TREASURY_BURSTS; i += 1) {
    const hrMin = hrMax + 1;
    hrMax += MATURITY_STEP;
    const val = getEmissionSumRange(hrMin, hrMax, TREASURY_BASE);
    bursts.push({ height: hrMax, val });
  }
  bursts.sort((a, b) => a.height - b.height);
  return bursts;
}

const TREASURY_BURST_TABLE = buildTreasuryBurstTable();

export function treasuryReleasedAtHeight(height: number): number {
  let cum = 0;
  for (const b of TREASURY_BURST_TABLE) {
    if (b.height > height) break;
    cum += b.val;
  }
  return cum;
}

export interface SupplySnapshot { total: number; miner: number; treasury: number }

export function expectedSupplyFast(height: number): SupplySnapshot {
  const h = Math.max(0, Math.floor(height));
  const miner = h < 1 ? 0 : getEmissionSumRange(1, h, EMIT_BASE);
  const treasury = treasuryReleasedAtHeight(h);
  return { total: miner + treasury, miner, treasury };
}

export function blockRewardAtHeight(h: number): number {
  return h < 1 ? 0 : getEmissionEx(h, EMIT_BASE).rate;
}

export function emissionRateChangeHeights(tip: number): Set<number> {
  const heights = new Set<number>();
  let hPos = 1;
  while (hPos <= tip) {
    const { rate, hEnd } = getEmissionEx(hPos, EMIT_BASE);
    if (!rate) break;
    if (hEnd <= tip) heights.add(hEnd);
    hPos = hEnd;
  }
  return heights;
}

export function parseExplorerNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = Number(v.replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function extractStatusMetric(node: unknown, label: string): number | null {
  if (!node) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      if (
        Array.isArray(item) && item.length >= 2
        && (item[0] as { type?: string; value?: unknown })?.type === 'th'
        && (item[0] as { value?: unknown })?.value === label
      ) {
        const raw = (item[1] as { value?: unknown })?.value ?? item[1];
        const parsed = parseExplorerNumber(raw);
        if (parsed !== null) return parsed;
      }
      const nested = extractStatusMetric(item, label);
      if (nested !== null) return nested;
    }
    return null;
  }
  if (typeof node === 'object') {
    for (const key of Object.keys(node as Record<string, unknown>)) {
      const nested = extractStatusMetric((node as Record<string, unknown>)[key], label);
      if (nested !== null) return nested;
    }
  }
  return null;
}

export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

export function fmtAmount(n: number): string {
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 8 });
}

export function fmtDateFromHeight(height: number): string {
  // Beam mainnet launched 2019-01-03, 1 block/minute.
  const genesisMs = Date.UTC(2019, 0, 3, 0, 0, 0);
  const d = new Date(genesisMs + Math.max(0, height) * 60 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
