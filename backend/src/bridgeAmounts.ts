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

/** The same threshold as a decimal literal, for SQL that has to agree with it. */
export const UINT64_SIGN_BIT_SQL = UINT64_SIGN_BIT.toString();
const UINT64 = 2n ** 64n;
const UINT256_MAX = 2n ** 256n - 1n;

function toBig(raw: string | null): bigint | null {
  if (raw === null || !/^\d+$/.test(raw)) return null;
  return BigInt(raw);
}

/**
 * Why a message's figures are not a real transfer. Keyed on direction because
 * each side wraps differently:
 *
 *   eth2beam  'overflow'   The Ethereum Pipe adds amount + relayerFee unchecked
 *                          (solidity ^0.7.2), so an overflowing pair wraps the
 *                          total down to almost nothing — an attempt, not a
 *                          transfer. The relayer rejects on this same test.
 *   beam2eth  'underflow'  A Beam Amount is uint64 and the fee is subtracted
 *                          without a check, storing the wrapped difference.
 *
 * Never swap them: Ethereum amounts are uint256 and pass 2^63 legitimately on
 * any 18-decimal asset (100 DAI is 1e20 raw).
 */
export function classifyAmounts(
  direction: string,
  amountRaw: string | null,
  feeRaw: string | null,
): MalformedReason | null {
  const amount = toBig(amountRaw);
  const fee = toBig(feeRaw);
  if (direction === 'beam2eth') {
    // Beam's whole supply is ~2.6e16 groths, so nothing legitimate approaches
    // 2^63 and the top bit alone identifies the wrap.
    const wrapped = (amount !== null && amount >= UINT64_SIGN_BIT)
      || (fee !== null && fee >= UINT64_SIGN_BIT);
    return wrapped ? 'underflow' : null;
  }
  if (amount === null || fee === null) return null;
  return amount > UINT256_MAX - fee ? 'overflow' : null;
}

/**
 * The signed value an underflowed uint64 meant to hold. Printing -50 rather than
 * the stored 2^64 - 50e8 is the difference between "the fee overshot by 50" and
 * an apparent 184-billion-BEAM transfer.
 */
export function unwrapUint64(raw: string): string {
  return (BigInt(raw) - UINT64).toString();
}
