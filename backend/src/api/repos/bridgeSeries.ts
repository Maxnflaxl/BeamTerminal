import { q } from '../../db.js';
import { scale, classifyAmounts } from '../../bridgeAmounts.js';
import { BRIDGES, type BridgeDef } from '../../services/bridge.js';
import { type Bucket, loadRatePricer } from '../../services/bridgeTvl.js';

// ---------------------------------------------------------------------------
// Transfer-count and relayer-fee series over bridge_messages.
//
// Both are flows, not balances, so unlike bridgeTvl there is no escrow anchor
// to reconstruct against and no need to densify a sparse spine: a bucket with
// no activity simply has no point.
// ---------------------------------------------------------------------------

export type { Bucket };
export type TransferSplit = 'none' | 'direction' | 'bridge';

export interface SeriesPoint {
  ts: number;
  value: number;
}

export interface SplitSeries {
  key: string;
  label: string;
  points: SeriesPoint[];
}

const DEFS_BY_KEY = new Map(BRIDGES.map((d) => [d.key, d]));

function directionLabel(direction: string): string {
  return direction === 'beam2eth' ? 'Beam → Ethereum' : 'Ethereum → Beam';
}

function splitKey(split: TransferSplit, direction: string, bridge: string): string {
  if (split === 'direction') return direction;
  if (split === 'bridge') return bridge;
  return 'total';
}

function splitLabel(split: TransferSplit, direction: string, bridge: string): string {
  if (split === 'direction') return directionLabel(direction);
  if (split === 'bridge') return DEFS_BY_KEY.get(bridge)?.label ?? bridge;
  return 'Total';
}

function toSeries(
  split: TransferSplit,
  rows: Array<{ ts: number; direction: string; bridge: string; value: number }>,
): SplitSeries[] {
  const byKey = new Map<string, SplitSeries>();
  for (const r of rows) {
    const key = splitKey(split, r.direction, r.bridge);
    let series = byKey.get(key);
    if (!series) {
      series = { key, label: splitLabel(split, r.direction, r.bridge), points: [] };
      byKey.set(key, series);
    }
    const last = series.points[series.points.length - 1];
    if (last && last.ts === r.ts) {
      last.value += r.value;
    } else {
      series.points.push({ ts: r.ts, value: r.value });
    }
  }
  return [...byKey.values()];
}

function toTotals(rows: Array<{ ts: number; value: number }>): SeriesPoint[] {
  const byTs = new Map<number, number>();
  for (const r of rows) byTs.set(r.ts, (byTs.get(r.ts) ?? 0) + r.value);
  const spine = [...byTs.keys()].sort((a, b) => a - b);
  let running = 0;
  return spine.map((ts) => {
    running += byTs.get(ts)!;
    return { ts, value: running };
  });
}

// ---------------------------------------------------------------------------
// Transfers: every message with a source timestamp counts, the wrapped ones
// included — they really were pushed into the bridge. Only value figures are
// filtered.
// ---------------------------------------------------------------------------

interface CountRow {
  ts: string;
  direction: string;
  bridge: string;
  n: string;
}

const COUNT_SQL = `
  SELECT EXTRACT(epoch FROM date_trunc($1, src_ts AT TIME ZONE 'UTC'))::bigint AS ts,
         direction, bridge, count(*)::bigint AS n
    FROM bridge_messages
   WHERE src_ts IS NOT NULL
   GROUP BY 1, 2, 3
   ORDER BY 1
`;

async function countRows(bucket: Bucket): Promise<Array<{ ts: number; direction: string; bridge: string; value: number }>> {
  const { rows } = await q<CountRow>(COUNT_SQL, [bucket]);
  return rows.map((r) => ({ ts: Number(r.ts), direction: r.direction, bridge: r.bridge, value: Number(r.n) }));
}

export async function bridgeTransfers(bucket: Bucket, split: TransferSplit): Promise<SplitSeries[]> {
  return toSeries(split, await countRows(bucket));
}

export async function bridgeTransfersTotal(bucket: Bucket): Promise<SeriesPoint[]> {
  return toTotals(await countRows(bucket));
}

// ---------------------------------------------------------------------------
// Relayer fees: denominated per-bridge in that bridge's asset, so they can
// only be summed across bridges once converted to USD at the bucket's rate
// for the bridge's aid — the same cross-rate bridgeTvl prices collateral with.
// ---------------------------------------------------------------------------

interface FeeRow {
  ts: string;
  direction: string;
  bridge: string;
  amount: string | null;
  relayer_fee: string | null;
}

const FEE_SQL = `
  SELECT EXTRACT(epoch FROM date_trunc($1, src_ts AT TIME ZONE 'UTC'))::bigint AS ts,
         direction, bridge, amount::text AS amount, relayer_fee::text AS relayer_fee
    FROM bridge_messages
   WHERE src_ts IS NOT NULL AND relayer_fee IS NOT NULL
   ORDER BY ts
`;

async function feeUsdRows(
  bucket: Bucket,
): Promise<Array<{ ts: number; direction: string; bridge: string; value: number }>> {
  const [{ rows }, pricer] = await Promise.all([q<FeeRow>(FEE_SQL, [bucket]), loadRatePricer(bucket)]);

  const out: Array<{ ts: number; direction: string; bridge: string; value: number }> = [];
  for (const row of rows) {
    const def: BridgeDef | undefined = DEFS_BY_KEY.get(row.bridge);
    if (!def) continue;
    const ts = Number(row.ts);
    // Amounts are denominated on whichever side the message was observed, so
    // each direction carries its own decimals: bUSDT is 8 on Beam against
    // USDT's 6 on Ethereum, bDAI 8 against DAI's 18.
    const dec = row.direction === 'beam2eth' ? def.decimals : def.ethDecimals;
    const fee = scale(row.relayer_fee, dec);
    if (fee === null) continue;
    // Wrapped arithmetic, not a fee anyone paid. The amount comes along because
    // an overflow is a property of the pair, not of either figure alone.
    if (classifyAmounts(row.direction, row.amount, row.relayer_fee) !== null) continue;

    const rate = pricer.priceAt(def.aid, ts);
    if (rate === null) continue;

    out.push({ ts, direction: row.direction, bridge: row.bridge, value: fee * rate });
  }
  return out;
}

export async function bridgeFees(bucket: Bucket, split: TransferSplit): Promise<SplitSeries[]> {
  return toSeries(split, await feeUsdRows(bucket));
}

export async function bridgeFeesTotal(bucket: Bucket): Promise<SeriesPoint[]> {
  return toTotals(await feeUsdRows(bucket));
}
