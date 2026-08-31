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
