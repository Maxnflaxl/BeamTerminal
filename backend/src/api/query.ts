import { z } from 'zod';

/**
 * Query-string boolean, with the value used when the param is absent.
 *
 * `z.coerce.boolean()` is `Boolean(value)`, and every query param arrives as a
 * string — so `?flag=0` and `?flag=false` both coerce to **true**, silently
 * making these flags write-only. Parse the textual forms instead: `1/true/yes/on`
 * (case-insensitive) are true, `0/false/no/off` and an empty value are false,
 * and anything else is a 400 rather than a guess.
 */
export function queryBool(fallback: boolean) {
  return z
    .string()
    .optional()
    .transform((v, ctx): boolean => {
      if (v === undefined) return fallback;
      const s = v.trim().toLowerCase();
      if (s === '' || s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
      if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `expected a boolean, got "${v}"` });
      return z.NEVER;
    });
}
