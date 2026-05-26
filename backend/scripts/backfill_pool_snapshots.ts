/**
 * One-off: reconstruct per-day end-of-day pool reserves from confirmed
 * `lp_events` and `trades`, and write them into `pool_state_snapshots` so
 * the TVL chart has full history back to DEX deploy.
 *
 * Algorithm per pool:
 *   - Start with (r1, r2, ctl) = (0, 0, 0).
 *   - Replay events in (block_ts, height, event_id) order.
 *     - Deposit:  r1 += amount1,    r2 += amount2,    ctl += amount_ctl.
 *     - Withdraw: r1 -= amount1,    r2 -= amount2,    ctl -= amount_ctl.
 *     - Trade:    r(aid_in)  += amount_in - fee_groth,
 *                 r(aid_out) -= amount_out.
 *       fee_groth is required (the parser pulls it from the nested DaoVault
 *       Deposit row); skip the trade with a warning if it's NULL.
 *   - After all events for a day, emit one snapshot at the end-of-UTC-day for
 *     that day with current (r1, r2, ctl).
 *   - For UTC days between event-bearing days, emit carry-forward snapshots
 *     with the prior day's state — the TVL chart's `time_bucket / last()`
 *     query needs at least one row per day per pool to fill the series.
 *   - Stop at yesterday (UTC); today belongs to the live indexer.
 *
 * Idempotent: ON CONFLICT (pool_id, ts) DO UPDATE re-writes any prior
 * backfilled row.
 *
 * Pause the indexer first:
 *   docker compose stop indexer
 *
 * Run with:
 *   yarn tsx scripts/backfill_pool_snapshots.ts
 *   yarn tsx scripts/backfill_pool_snapshots.ts --pool=42
 */
import { q, shutdown, type QueryArg } from '../src/db.js';
import { logger } from '../src/logger.js';

interface PoolRow {
  pool_id: string;
  aid1: number;
  aid2: number;
}

interface EventRow {
  kind: 'deposit' | 'withdraw' | 'trade';
  block_ts: Date;
  height: number;
  sort_key: number; // event_id or trade_id; tie-breaker within a block
  amount1: string | null;
  amount2: string | null;
  amount_ctl: string | null;
  aid_in: number | null;
  amount_in: string | null;
  amount_out: string | null;
  fee_groth: string | null;
}

function parseArg(name: string): string | undefined {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.split('=')[1] : undefined;
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function endOfUtcDay(dayStart: Date): Date {
  // 23:59:59 of the same UTC day.
  return new Date(dayStart.getTime() + 86_400_000 - 1_000);
}

function nextUtcDay(dayStart: Date): Date {
  return new Date(dayStart.getTime() + 86_400_000);
}

async function loadPools(filter: string | undefined): Promise<PoolRow[]> {
  const where = filter ? `WHERE pool_id = $1` : '';
  const params = filter ? [Number(filter)] : [];
  const { rows } = await q<{ pool_id: string; aid1: number; aid2: number }>(
    `SELECT pool_id::text, aid1::int, aid2::int FROM pools ${where} ORDER BY pool_id`,
    params,
  );
  return rows;
}

async function loadEvents(poolId: string): Promise<EventRow[]> {
  // Confirmed events only — unconfirmed rows may still be reorged away.
  const { rows } = await q<EventRow>(
    `
    SELECT 'deposit'::text AS kind,
           block_ts, height, event_id::bigint AS sort_key,
           amount1::text, amount2::text, amount_ctl::text,
           NULL::int   AS aid_in,
           NULL::text  AS amount_in,
           NULL::text  AS amount_out,
           NULL::text  AS fee_groth
      FROM lp_events
     WHERE pool_id = $1 AND confirmed = TRUE AND kind = 'Deposit'
    UNION ALL
    SELECT 'withdraw'::text AS kind,
           block_ts, height, event_id::bigint AS sort_key,
           amount1::text, amount2::text, amount_ctl::text,
           NULL::int, NULL::text, NULL::text, NULL::text
      FROM lp_events
     WHERE pool_id = $1 AND confirmed = TRUE AND kind = 'Withdraw'
    UNION ALL
    SELECT 'trade'::text AS kind,
           block_ts, height, trade_id::bigint AS sort_key,
           NULL::text, NULL::text, NULL::text,
           aid_in::int,
           amount_in::text, amount_out::text, fee_groth::text
      FROM trades
     WHERE pool_id = $1 AND confirmed = TRUE
     ORDER BY 2, 3, 4
    `,
    [poolId],
  );
  return rows;
}

interface Snapshot {
  ts: Date;
  height: number;
  r1: bigint;
  r2: bigint;
  ctl: bigint;
}

async function bulkUpsert(poolId: string, snaps: Snapshot[]): Promise<void> {
  if (snaps.length === 0) return;
  // Chunk to keep the parameter count under Postgres' 65,535 limit
  // (5 cols per row → 13,000 rows per chunk).
  const CHUNK = 5_000;
  for (let i = 0; i < snaps.length; i += CHUNK) {
    const slice = snaps.slice(i, i + CHUNK);
    const placeholders: string[] = [];
    const params: QueryArg[] = [];
    let p = 1;
    for (const s of slice) {
      placeholders.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
      params.push(poolId, s.height, s.ts, s.r1.toString(), s.r2.toString(), s.ctl.toString());
    }
    await q(
      `INSERT INTO pool_state_snapshots (pool_id, height, ts, reserve1, reserve2, ctl_supply)
       VALUES ${placeholders.join(', ')}
       ON CONFLICT (pool_id, ts)
       DO UPDATE SET reserve1   = EXCLUDED.reserve1,
                     reserve2   = EXCLUDED.reserve2,
                     ctl_supply = EXCLUDED.ctl_supply,
                     height     = EXCLUDED.height`,
      params,
    );
  }
}

async function backfillPool(
  pool: PoolRow,
  endDay: Date,
  stats: { tradesWithoutFee: number; negativeReserve: number },
): Promise<number> {
  const events = await loadEvents(pool.pool_id);
  if (events.length === 0) return 0;

  let r1 = 0n;
  let r2 = 0n;
  let ctl = 0n;

  const snaps: Snapshot[] = [];
  let curDay = startOfUtcDay(events[0]!.block_ts);
  let curHeight = events[0]!.height;

  const emit = (day: Date): void => {
    snaps.push({ ts: endOfUtcDay(day), height: curHeight, r1, r2, ctl });
  };

  for (const e of events) {
    const eDay = startOfUtcDay(e.block_ts);
    while (eDay.getTime() > curDay.getTime()) {
      emit(curDay);
      curDay = nextUtcDay(curDay);
    }

    if (e.kind === 'deposit') {
      r1 += BigInt(e.amount1!);
      r2 += BigInt(e.amount2!);
      ctl += BigInt(e.amount_ctl!);
    } else if (e.kind === 'withdraw') {
      r1 -= BigInt(e.amount1!);
      r2 -= BigInt(e.amount2!);
      ctl -= BigInt(e.amount_ctl!);
    } else {
      // trade
      if (e.fee_groth === null) {
        stats.tradesWithoutFee++;
        // Without the fee we'd accumulate drift; skip rather than guess.
        // After running backfill_trade_fees these should be 0.
        continue;
      }
      const aIn = BigInt(e.amount_in!);
      const aOut = BigInt(e.amount_out!);
      const fee = BigInt(e.fee_groth);
      const netIn = aIn - fee;
      if (e.aid_in === pool.aid1) {
        r1 += netIn;
        r2 -= aOut;
      } else if (e.aid_in === pool.aid2) {
        r2 += netIn;
        r1 -= aOut;
      } else {
        // Should never happen — trade's aid_in must be one of the pool's pair.
        continue;
      }
    }

    if (r1 < 0n || r2 < 0n) {
      stats.negativeReserve++;
      // Clamp to zero; negatives mean we missed an event (e.g. an unconfirmed
      // Withdraw that was promoted differently). Better to under-report TVL
      // than NaN the chart.
      if (r1 < 0n) r1 = 0n;
      if (r2 < 0n) r2 = 0n;
    }

    curHeight = e.height;
  }

  // Final event-bearing day.
  emit(curDay);

  // Carry forward to yesterday.
  while (nextUtcDay(curDay).getTime() <= endDay.getTime()) {
    curDay = nextUtcDay(curDay);
    emit(curDay);
  }

  await bulkUpsert(pool.pool_id, snaps);
  return snaps.length;
}

async function main(): Promise<void> {
  const poolFilter = parseArg('pool');

  // Backfill up to and including yesterday (UTC). Today is the live indexer's
  // job — and we don't want to insert a 23:59:59 snapshot for an incomplete
  // day.
  const today = startOfUtcDay(new Date());
  const yesterday = new Date(today.getTime() - 86_400_000);

  const pools = await loadPools(poolFilter);
  logger.info({ pools: pools.length, end_day: yesterday.toISOString() }, 'pool snapshot backfill starting');

  const stats = { tradesWithoutFee: 0, negativeReserve: 0 };
  const t0 = Date.now();
  let totalSnaps = 0;

  for (const pool of pools) {
    const inserted = await backfillPool(pool, yesterday, stats);
    totalSnaps += inserted;
    logger.info(
      { pool_id: pool.pool_id, aid1: pool.aid1, aid2: pool.aid2, snapshots: inserted },
      'pool done',
    );
  }

  logger.info(
    {
      pools: pools.length,
      snapshots: totalSnaps,
      trades_without_fee: stats.tradesWithoutFee,
      negative_reserve_events: stats.negativeReserve,
      elapsed_s: +((Date.now() - t0) / 1000).toFixed(1),
    },
    'backfill complete',
  );
}

main()
  .catch((err) => {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'fatal');
    process.exitCode = 1;
  })
  .finally(() => shutdown());
