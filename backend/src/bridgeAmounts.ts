// Amount handling shared by every bridge read model. Both helpers encode a
// property of the stored data rather than of any one endpoint, so they live
// outside `api/repos` — services need them too, and a service importing a
// route's repo would invert the layering.

export function scale(raw: string | null, decimals: number): number | null {
  if (raw === null) return null;
  // Amounts are NUMERIC(40,0) strings well past Number.MAX_SAFE_INTEGER in
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

// Values at or near 2^256 aren't transfers, they're junk pushed into the Pipe.
// Scaled by the asset's decimals they still land astronomically high, so one
// threshold catches them regardless of which side they came from.
export const ABSURD = 1e20;

// The spam predicate, in one place. Every read model that puts a bridge value
// in front of a reader — TVL, fee series, single-message explanations — has to
// draw the junk line in exactly the same spot; three hand-written spellings of
// it is how the next spam shape gets through one of them and not the others.
// A message is junk if ANY of its scaled figures is absurd: the spam carries a
// uint256-max relayer fee alongside a merely large amount, so testing the sum
// alone would depend on which fields a given call site happened to add up.
export function isAbsurdAmount(...values: ReadonlyArray<number | null>): boolean {
  return values.some((v) => v !== null && Math.abs(v) >= ABSURD);
}

// A Beam-side Amount is a uint64, and the Pipe subtracts the relayer fee from
// the transferred amount without checking that it fits: a message whose fee
// exceeds its amount stores the wrapped difference, a value just below 2^64.
// Scaled it reads as a plausible-looking ~1.8e11, so the ABSURD threshold above
// never sees it — the wrap has to be caught on the raw groths.
//
// Only Beam-side figures can wrap this way. Ethereum-side amounts are uint256
// and legitimately exceed 2^63 whenever the asset carries 18 decimals (100 DAI
// is 1e20 raw), so this must never be applied to them.
const UINT64_SIGN_BIT = 2n ** 63n;

/**
 * True when a raw Beam-side amount has its top bit set. Beam's entire supply is
 * ~2.6e16 groths, four orders of magnitude below 2^63, so nothing legitimate
 * reaches the threshold and the wrap is unambiguous.
 */
export function isWrappedUint64(raw: string | null): boolean {
  if (raw === null) return false;
  if (!/^\d+$/.test(raw)) return false;
  return BigInt(raw) >= UINT64_SIGN_BIT;
}
