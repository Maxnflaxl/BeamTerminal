// BEAM's circulating supply as a function of block height.
//
// Mirrors beam/core/block_crypt.cpp `Rules::get_Emission` and
// beam/core/treasury.cpp `Treasury::CreatePlan` (mainnet). The frontend runs
// the same model in explorer/supplyMath.ts to draw the Supply page; the two
// are separate ports of one upstream source, so a change to the schedule has
// to land in both.
//
// Checked against production: at indexed height 4,006,678 this returns
// 192,146,950 BEAM, which is `assets.emission` for aid 0 to the groth, and
// `blockRewardAtHeight` there returns the 25 the explorer's /status
// advertises as Next Block Reward.
//
// This lives in TypeScript rather than in a chart's SQL because neither half
// of the schedule is smooth:
//
//   - The miner reward is integer-truncated. From the second halving the base
//     is raised by a quarter (`b += b >> 2`, the treasury's share reverting to
//     miners once vesting ends), so the ladder runs 80, 40, 25, 12, 6 — not
//     80, 40, 20, 10. A closed form over 25·2^-k drifts from the third
//     halving on.
//   - The treasury is not released per block but in 60 monthly bursts over the
//     first five years. A per-block average of it is up to 0.48% wrong at any
//     point inside that window, which covers everything before January 2024.
//
// Both were measured against the exact model before this file existed.

const DROP0 = 1440 * 365; // one year of 1-minute blocks
const DROP1 = 1440 * 365 * 4; // and every four years after that
const EMIT_BASE = 80;
const TREASURY_BASE = EMIT_BASE / 4; // 20 of the first year's 80
const MATURITY_STEP = Math.floor((1440 * 365) / 12); // one treasury burst a month
const TREASURY_BURSTS = 12 * 5; // for five years

interface Emission {
  /** Whole BEAM per block over the era containing `h`. */
  rate: number;
  /** First height of the next era. */
  hEnd: number;
}

function emissionAt(h: number, base: number): Emission {
  const b0 = Math.floor(base);
  if (!b0 || h < 1) return { rate: 0, hEnd: 0 };
  const hp = h - 1;
  if (hp < DROP0) return { rate: b0, hEnd: DROP0 + 1 };
  const n = 1 + Math.floor((hp - DROP0) / DROP1);
  // Past the 53rd halving the reward truncates to zero and emission stops.
  if (n >= 53) return { rate: 0, hEnd: Number.MAX_SAFE_INTEGER };
  const hEnd = DROP0 + n * DROP1 + 1;
  let b = b0;
  if (n >= 2) b += b >> 2;
  // eslint-disable-next-line no-bitwise -- the node halves by shifting; so do we.
  return { rate: b >> n, hEnd };
}

function sumRange(hrMin: number, hrMax: number, base: number): number {
  if (hrMax < hrMin) return 0;
  let res = 0;
  let hPos = hrMin;
  for (;;) {
    const { rate, hEnd } = emissionAt(hPos, base);
    if (!rate) break;
    if (hrMax < hEnd) {
      res += rate * (hrMax - hPos + 1);
      break;
    }
    res += rate * (hEnd - hPos);
    hPos = hEnd;
  }
  return res;
}

const TREASURY_BURST_TABLE: ReadonlyArray<{ height: number; val: number }> = (() => {
  const out: Array<{ height: number; val: number }> = [];
  let hrMax = 0;
  for (let i = 0; i < TREASURY_BURSTS; i += 1) {
    const hrMin = hrMax + 1;
    hrMax += MATURITY_STEP;
    out.push({ height: hrMax, val: sumRange(hrMin, hrMax, TREASURY_BASE) });
  }
  return out;
})();

function treasuryReleasedAt(height: number): number {
  let cum = 0;
  for (const b of TREASURY_BURST_TABLE) {
    if (b.height > height) break;
    cum += b.val;
  }
  return cum;
}

/** Circulating BEAM at `height` — mined plus treasury released, in whole coins. */
export function supplyAtHeight(height: number): number {
  const h = Math.max(0, Math.floor(height));
  return (h < 1 ? 0 : sumRange(1, h, EMIT_BASE)) + treasuryReleasedAt(h);
}

/** Whole BEAM paid to the miner of block `h`. */
export function blockRewardAtHeight(h: number): number {
  return h < 1 ? 0 : emissionAt(h, EMIT_BASE).rate;
}
