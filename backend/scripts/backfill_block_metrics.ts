/**
 * One-off: walk every block from `--from` (default 1) up to current head,
 * persisting per-block chainwork / kernel count / difficulty into the
 * `block_metrics` hypertable. Idempotent: existing heights are skipped on
 * conflict and a resume point is taken from MAX(height) in the table.
 *
 * Run via:
 *   yarn tsx scripts/backfill_block_metrics.ts                # resume → head
 *   yarn tsx scripts/backfill_block_metrics.ts --from=1 --to=100000
 */
import { shutdown } from '../src/db.js';
import { getStatus } from '../src/explorer.js';
import { logger } from '../src/logger.js';
import { ingestRange, maxIndexedHeight } from '../src/services/blockMetrics.js';

function parseArg(name: string): number | undefined {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!arg) return undefined;
  const n = Number(arg.split('=')[1]);
  return Number.isFinite(n) ? n : undefined;
}

async function main(): Promise<void> {
  const cliFrom = parseArg('from');
  const cliTo = parseArg('to');
  const concurrency = parseArg('concurrency') ?? 8;

  const status = await getStatus();
  const head = cliTo ?? status.height;

  // Resume point: pick up where a previous run left off unless explicitly overridden.
  const resume = cliFrom !== undefined ? cliFrom : ((await maxIndexedHeight()) ?? 0) + 1;
  if (resume > head) {
    logger.info({ resume, head }, 'nothing to do');
    return;
  }

  logger.info({ from: resume, to: head, concurrency }, 'block_metrics backfill starting');

  const startedAt = Date.now();
  let lastLog = startedAt;
  const total = head - resume + 1;

  const inserted = await ingestRange(resume, head, {
    concurrency,
    onProgress: (h) => {
      const now = Date.now();
      if (now - lastLog < 5_000) return;
      lastLog = now;
      const done = h - resume + 1;
      const pct = (done / total) * 100;
      const elapsed = now - startedAt;
      const etaSec = done > 0 ? Math.round((elapsed / done) * (total - done) / 1000) : null;
      logger.info({ height: h, pct: +pct.toFixed(2), eta_seconds: etaSec }, 'progress');
    },
  });

  logger.info({ inserted, from: resume, to: head, elapsed_sec: Math.round((Date.now() - startedAt) / 1000) }, 'backfill done');
}

main()
  .catch((err) => {
    logger.error({ err: err instanceof Error ? err.message : err }, 'backfill failed');
    process.exitCode = 1;
  })
  .finally(() => shutdown());
