import { q } from './db.js';
import { logger } from './logger.js';

/**
 * Hardcoded list of imposter / scam assets. Ported from
 * `dex-app/src/app/shared/constants/imposterAssets.ts`.
 *
 * Each entry: `[fakeAid, realAid]`. The `realAid` is informational so we can
 * surface "did you mean X?" in the UI.
 *
 * Add new entries here + restart any process (indexer or api). The
 * `seedImposters()` function below is idempotent and pushes the flag into the
 * `assets` table on startup.
 */
export interface ImposterEntry {
  fake_aid: number;
  real_aid: number;
  symbol_hint?: string;
}

export const IMPOSTERS: ReadonlyArray<ImposterEntry> = [
  // BEAM-likes
  { fake_aid: 24, real_aid: 0,  symbol_hint: 'BEAM' },
  { fake_aid: 26, real_aid: 7,  symbol_hint: 'BEAMX' },

  // Bridge fakes
  { fake_aid: 40, real_aid: 36, symbol_hint: 'bETH' },
  { fake_aid: 17, real_aid: 36, symbol_hint: 'bETH' },
  { fake_aid: 41, real_aid: 37, symbol_hint: 'bUSDT' },
  { fake_aid: 18, real_aid: 37, symbol_hint: 'bUSDT' },
  { fake_aid: 42, real_aid: 38, symbol_hint: 'bWBTC' },
  { fake_aid: 19, real_aid: 38, symbol_hint: 'bWBTC' },
  { fake_aid: 43, real_aid: 39, symbol_hint: 'bDAI' },
  { fake_aid: 35, real_aid: 39, symbol_hint: 'bDAI' },

  // Other
  { fake_aid: 25, real_aid: 9,  symbol_hint: 'TICO' },
];

/**
 * Mark every IMPOSTERS-listed AID as imposter=TRUE in the `assets` table.
 * Also resets any AID *not* in the list back to imposter=FALSE — so removing
 * an entry from this file un-flags it on the next startup.
 *
 * Idempotent. Safe to call repeatedly. No-op if the assets table is empty.
 */
export async function seedImposters(): Promise<void> {
  if (IMPOSTERS.length === 0) {
    logger.info('imposters list is empty');
    return;
  }

  const fakeAids = IMPOSTERS.map((e) => e.fake_aid);

  // Mark listed AIDs as imposters with their `real_aid` reason.
  for (const entry of IMPOSTERS) {
    await q(
      `UPDATE assets
          SET is_imposter     = TRUE,
              imposter_reason = $2
        WHERE aid = $1`,
      [
        entry.fake_aid,
        `Fake ${entry.symbol_hint ?? `aid ${entry.real_aid}`} — real is aid ${entry.real_aid}`,
      ],
    );
  }

  // Un-flag anything that was previously marked but is no longer on the list.
  await q(
    `UPDATE assets
        SET is_imposter     = FALSE,
            imposter_reason = NULL
      WHERE is_imposter = TRUE
        AND aid NOT IN (SELECT unnest($1::bigint[]))`,
    [fakeAids],
  );

  logger.info({ count: IMPOSTERS.length }, 'imposters seeded');
}
