/**
 * One-off: re-walk every AMM call from DEX deploy to current head and
 * upsert into the `trades` table so the new `fee_groth` column (added in
 * migration 018) is populated. The INSERT uses
 *   ON CONFLICT ... DO UPDATE SET fee_groth = EXCLUDED.fee_groth
 *     WHERE trades.fee_groth IS NULL
 * so existing rows with the column already filled are left alone, and
 * brand-new trades (if any landed before the indexer was paused) get
 * inserted cleanly.
 *
 * Pause the indexer container before running so writes don't race:
 *   docker compose stop indexer
 *
 * Run with:
 *   yarn tsx scripts/backfill_trade_fees.ts
 *   yarn tsx scripts/backfill_trade_fees.ts --from=3000000 --to=3100000
 */
import { shutdown } from '../src/db.js';
import { getStatus } from '../src/explorer.js';
import { logger } from '../src/logger.js';
import { config } from '../src/config.js';
import { indexCalls } from '../src/services/calls.js';
import { findDexDeployHeight } from '../src/services/backfill.js';

const PAGE = 50_000;

function parseArg(name: string): number | undefined {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!arg) return undefined;
  const n = Number(arg.split('=')[1]);
  return Number.isFinite(n) ? n : undefined;
}

async function main(): Promise<void> {
  const cliFrom = parseArg('from');
  const cliTo = parseArg('to');

  const head = cliTo ?? (await getStatus()).height;
  const start = cliFrom ?? config.DEX_DEPLOY_HEIGHT ?? (await findDexDeployHeight());
  if (start === undefined || start === null) {
    logger.error('cannot determine DEX deploy height — set DEX_DEPLOY_HEIGHT in .env or pass --from');
    return;
  }
  if (start > head) {
    logger.info({ start, head }, 'nothing to do');
    return;
  }

  const totalBlocks = head - start + 1;
  logger.info({ start, head, page_size: PAGE }, 'trade fee backfill starting');

  const t0 = Date.now();
  let totalTrades = 0;
  let totalLp = 0;
  let totalSkipped = 0;

  for (let hMin = start; hMin <= head; hMin = hMin + PAGE + 1) {
    const hMax = Math.min(hMin + PAGE, head);
    const r = await indexCalls(hMin, hMax);
    totalTrades += r.trades;
    totalLp += r.lp;
    totalSkipped += r.skipped;

    const elapsedSec = (Date.now() - t0) / 1000;
    const done = hMax - start + 1;
    const pct = (done / totalBlocks) * 100;
    const etaSec = done > 0 ? Math.round((elapsedSec / done) * (totalBlocks - done)) : null;
    logger.info(
      {
        hMin,
        hMax,
        trades: r.trades,
        lp: r.lp,
        skipped: r.skipped,
        pct: +pct.toFixed(1),
        elapsed_s: +elapsedSec.toFixed(1),
        eta_s: etaSec,
      },
      'page done',
    );
  }

  logger.info(
    { trades: totalTrades, lp: totalLp, skipped: totalSkipped, elapsed_s: +((Date.now() - t0) / 1000).toFixed(1) },
    'backfill complete',
  );
}

main()
  .catch((err) => {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'fatal');
    process.exitCode = 1;
  })
  .finally(() => shutdown());
