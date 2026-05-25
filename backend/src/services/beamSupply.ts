import { request } from 'undici';
import { config } from '../config.js';
import { q } from '../db.js';
import { logger } from '../logger.js';

// Wire format from /status?exp_am=1 — the extended ("ExplicitType") response
// mode returns a labeled table that includes BEAM's Current/Total Circulation,
// while the default JSON mode only has height/timestamp/peers.
//
// The amounts come back as formatted decimal *strings* like "262,799,999.76873600"
// (commas as thousand separators, always 8 fractional digits). We must convert
// to groths (decimal-shifted integer) without going through a JS float, or
// the last few digits get clobbered for treasury-flavored values.

interface AmountCell {
  type: 'amount';
  value: string;
}

interface ThCell {
  type: 'th';
  value: string;
}

function parseGroths(formatted: string): bigint {
  // "262,799,999.76873600" -> 26279999976873600n
  const clean = formatted.replace(/,/g, '').trim();
  const dot = clean.indexOf('.');
  const intPart = dot >= 0 ? clean.slice(0, dot) : clean;
  const decPart = dot >= 0 ? clean.slice(dot + 1) : '';
  const padded = (decPart + '00000000').slice(0, 8);
  return BigInt(intPart + padded);
}

interface BeamSupplySnapshot {
  current_circulation: bigint;
  total_circulation: bigint;
}

function parseStatusTotals(resp: unknown): BeamSupplySnapshot | null {
  // Shape: { type:"table", h, value:[[<info-tbl>, <totals-tbl>]] }
  // totals-tbl.value is an array of [thCell, amountCell] rows.
  if (typeof resp !== 'object' || resp === null) return null;
  const outer = resp as { value?: unknown };
  if (!Array.isArray(outer.value) || outer.value.length === 0) return null;
  const wrap = outer.value[0];
  if (!Array.isArray(wrap) || wrap.length < 2) return null;
  const totals = wrap[1] as { type?: string; value?: unknown };
  if (totals?.type !== 'table' || !Array.isArray(totals.value)) return null;

  let current: bigint | null = null;
  let total: bigint | null = null;
  for (const row of totals.value as unknown[]) {
    if (!Array.isArray(row) || row.length < 2) continue;
    const lbl = row[0] as ThCell;
    const val = row[1] as AmountCell | unknown;
    if (lbl?.type !== 'th') continue;
    if (typeof val !== 'object' || val === null) continue;
    const amount = val as AmountCell;
    if (amount.type !== 'amount' || typeof amount.value !== 'string') continue;

    if (lbl.value === 'Current Circulation') current = parseGroths(amount.value);
    else if (lbl.value === 'Total Circulation') total = parseGroths(amount.value);
  }

  if (current === null || total === null) return null;
  return { current_circulation: current, total_circulation: total };
}

/**
 * Reads the extended /status response (?exp_am=1) and writes BEAM's circulating
 * supply (`emission`) and capped supply (`max_supply`) into the aid 0 row.
 *
 * Returns true if the row was updated, false otherwise (network error, missing
 * fields, etc.). Failures are logged and swallowed — supply is decorative; an
 * upstream blip shouldn't take the indexer tick down with it.
 */
export async function syncBeamSupply(): Promise<boolean> {
  const url = `${config.EXPLORER_URL}/status?exp_am=1`;
  let body: unknown;
  try {
    const { statusCode, body: respBody } = await request(url, { method: 'GET' });
    if (statusCode >= 400) {
      logger.warn({ statusCode, url }, 'beam supply sync: non-2xx');
      return false;
    }
    body = await respBody.json();
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err },
      'beam supply sync: fetch failed',
    );
    return false;
  }

  const snap = parseStatusTotals(body);
  if (!snap) {
    logger.warn('beam supply sync: could not parse status totals');
    return false;
  }

  await q(
    `UPDATE assets
        SET emission   = $1,
            max_supply = $2
      WHERE aid = 0`,
    [snap.current_circulation.toString(), snap.total_circulation.toString()],
  );
  logger.info(
    {
      current_circulation: snap.current_circulation.toString(),
      total_circulation: snap.total_circulation.toString(),
    },
    'beam supply synced',
  );
  return true;
}
