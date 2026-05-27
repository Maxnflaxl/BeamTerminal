/**
 * Parses BEAM asset metadata strings into structured fields.
 *
 * Two observed shapes (mainnet):
 *   "STD:N=Tether;SN=USDT;UN=USD Tether;NTHUN=Cent"
 *   "STD:SCH_VER=1;N=RAYS;SN=RAYS;UN=RAYS;NTHUN=Flicker;OPT_SHORT_DESC=...;OPT_LONG_DESC=...;..."
 *
 * Format: leading "STD:" prefix, then `KEY=value` pairs separated by `;`.
 * Values may contain semicolons-themselves never (they're delimiters), and we
 * intentionally do not URL-decode them — they're already plain UTF-8 strings.
 */

export interface AssetMetadata {
  /** Full long name (e.g. "Tether"). */
  name?: string;
  /** Short ticker (e.g. "USDT"). */
  short_name?: string;
  /** Unit name (e.g. "USD Tether"). */
  unit_name?: string;
  /** Sub-unit name (e.g. "Cent"). */
  smallest_unit_name?: string;
  /** Optional one-line description. */
  description?: string;
  /** Long-form description (often paragraphs). */
  long_description?: string;
  /** Optional project URL. */
  site_url?: string;
  /** Optional logo URL. */
  logo_url?: string;
  /** Optional brand colour (hex, e.g. "#00e3c2"), from OPT_COLOR. */
  color?: string;
  /** Schema version if declared (older assets omit it). */
  schema_version?: string;
  /** Any other KEY=value pairs we don't have a dedicated field for. */
  extras: Record<string, string>;
}

const KEY_MAP: Record<string, keyof AssetMetadata> = {
  N: 'name',
  SN: 'short_name',
  UN: 'unit_name',
  NTHUN: 'smallest_unit_name',
  OPT_SHORT_DESC: 'description',
  OPT_LONG_DESC: 'long_description',
  OPT_SITE_URL: 'site_url',
  OPT_LOGO_URL: 'logo_url',
  OPT_COLOR: 'color',
  SCH_VER: 'schema_version',
};

export function parseAssetMetadata(raw: string | null | undefined): AssetMetadata {
  const out: AssetMetadata = { extras: {} };
  if (!raw) return out;

  // Strip a leading "STD:" prefix if present.
  const body = raw.startsWith('STD:') ? raw.slice(4) : raw;

  for (const segment of body.split(';')) {
    if (!segment) continue;
    const eq = segment.indexOf('=');
    if (eq < 0) continue;
    const key = segment.slice(0, eq).trim();
    const val = segment.slice(eq + 1);
    if (!key) continue;

    const mapped = KEY_MAP[key];
    if (mapped && mapped !== 'extras') {
      (out as unknown as Record<string, string>)[mapped] = val;
    } else {
      out.extras[key] = val;
    }
  }

  return out;
}
