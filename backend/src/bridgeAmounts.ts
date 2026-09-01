// Amount handling shared by every bridge read model. Both helpers encode a
// property of the stored data rather than of any one endpoint, so they live
// outside `api/repos` — services need them too, and a service importing a
// route's repo would invert the layering.

export function scale(raw: string | null, decimals: number): number | null {
  if (raw === null) return null;
  // Amounts are NUMERIC(80,0) strings well past Number.MAX_SAFE_INTEGER in
  // groths, so divide as BigInt first and only then convert for display.
  const neg = raw.startsWith('-');
  const digits = neg ? raw.slice(1) : raw;
  const d = BigInt(digits);
  const div = 10n ** BigInt(decimals);
  const whole = d / div;
  const frac = d % div;
  const val = Number(whole) + Number(frac) / Number(div);
  return neg ? -val : val;
}

/**
 * Why a message's figures are not a real transfer. Both are arithmetic that
 * wrapped in a Pipe contract, and each is exact — no threshold is involved, so
 * a message is either one of these or it is ordinary.
 */
export type MalformedReason = 'overflow' | 'underflow';

const UINT64_SIGN_BIT = 2n ** 63n;
const UINT64 = 2n ** 64n;
const UINT256_MAX = 2n ** 256n - 1n;

function toBig(raw: string | null): bigint | null {
  if (raw === null || !/^\d+$/.test(raw)) return null;
  return BigInt(raw);
}

/**
 * Classify a message's stored amount and relayer fee.
 *
 * Each direction wraps in its own way, so the test is keyed on direction rather
 * than on the size of the numbers:
 *
 *   eth2beam  'overflow'  The Ethereum Pipe (solidity ^0.7.2) computes
 *             `total = amount + relayerFee` with unchecked arithmetic. A pair
 *             that overflows wraps `total` down to a trivial sum, so the caller
 *             emits an enormous amount while paying almost nothing. These are
 *             attempts on the bridge, not transfers, and the relayer rejects
 *             them on exactly this predicate.
 *
 *   beam2eth  'underflow' A Beam Amount is a uint64, and the fee is subtracted
 *             from the transferred amount without checking that it fits. A fee
 *             larger than the amount stores the wrapped difference — a value
 *             just under 2^64, which scales to a plausible-looking ~1.8e11.
 *
 * The two tests are not interchangeable. Ethereum-side amounts are uint256 and
 * pass 2^63 legitimately on any 18-decimal asset (100 DAI is 1e20 raw), so the
 * uint64 test would condemn ordinary transfers; Beam-side amounts cannot reach
 * uint256 scale at all.
 */
export function classifyAmounts(
  direction: string,
  amountRaw: string | null,
  feeRaw: string | null,
): MalformedReason | null {
  const amount = toBig(amountRaw);
  const fee = toBig(feeRaw);
  if (direction === 'beam2eth') {
    // Beam's entire supply is ~2.6e16 groths, four orders of magnitude below
    // 2^63, so the top bit alone identifies the wrap.
    const wrapped = (amount !== null && amount >= UINT64_SIGN_BIT)
      || (fee !== null && fee >= UINT64_SIGN_BIT);
    return wrapped ? 'underflow' : null;
  }
  if (amount === null || fee === null) return null;
  return amount > UINT256_MAX - fee ? 'overflow' : null;
}

/**
 * The signed value an underflowed uint64 was meant to hold: a fee of 50 BEAM
 * taken from an amount of zero is stored as 2^64 - 50e8 and reads back as
 * -50e8. Printing that instead of the stored figure is the difference between
 * "the fee exceeded the amount by 50" and an apparent 184-billion-BEAM
 * transfer.
 */
export function unwrapUint64(raw: string): string {
  return (BigInt(raw) - UINT64).toString();
}
