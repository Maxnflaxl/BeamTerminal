import { q } from '../db.js';
import { logger } from '../logger.js';
import { scale, ABSURD } from '../bridgeAmounts.js';
import { BRIDGES, type BridgeDef } from './bridge.js';
import { pipeFundsDeltas } from './bridgePipeFunds.js';
import { getBlockTsMap } from './blockTimestamps.js';

// ---------------------------------------------------------------------------
// Historical value locked in the Beam <-> Ethereum Pipe bridges.
//
// `bridge_escrow` holds only a live snapshot, so the history is reconstructed
// from the flow that produced it — the message ledger for the bridges whose
// collateral sits on Ethereum, the Pipe's own signed Funds column for the two
// whose collateral sits on Beam.
//
// Both reconstructions are anchored to the measured snapshot rather than
// accumulated from zero: today's figure is the one a reader checks against the
// Bridge page, so it has to be exact, and any historical gap belongs in the
// far tail where it is visibly an offset instead of drifting into the present.
// ---------------------------------------------------------------------------

export type Bucket = 'day' | 'month';

export interface TvlPoint {
  ts: number;
  value: number;
}

export interface BridgeAssetSeries {
  key: string;
  label: string;
  /** Display precision for the native-unit values, not a raw-amount scale. */
  decimals: number;
  points: TvlPoint[];
}

const MS = 1000;
const DAY_SECONDS = 86_400;

function bucketOf(ts: Date, bucket: Bucket): number {
  const d = new Date(ts);
  return bucket === 'month'
    ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / MS
    : Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / MS;
}

function nextBucket(ts: number, bucket: Bucket): number {
  if (bucket === 'day') return ts + DAY_SECONDS;
  const d = new Date(ts * MS);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / MS;
}

// How long a cross-rate may stand in for a bucket that has none of its own.
// Past this the market has moved somewhere we cannot see, and quoting the stale
// rate would freeze the pool ratio and BEAM/USD together at whatever they were.
function maxRateHoldSeconds(bucket: Bucket): number {
  return bucket === 'day' ? 7 * DAY_SECONDS : 45 * DAY_SECONDS;
}

interface EscrowRow {
  bridge: string;
  locked: string;
  decimals: number;
  observed_at: Date;
}

interface EthFlowRow {
  bridge: string;
  direction: string;
  status: string;
  src_bucket: string | null;
  src_epoch: string | null;
  settle_bucket: string | null;
  settle_epoch: string | null;
  amount: string | null;
  relayer_fee: string | null;
}

// `AT TIME ZONE 'UTC'` before truncating pins the bucket boundary to UTC
// regardless of the session timezone, so it agrees with the boundaries the
// Beam-side deltas are bucketed into in TypeScript.
const ETH_FLOW_SQL = `
  SELECT bridge, direction, status,
         EXTRACT(epoch FROM date_trunc($1, src_ts    AT TIME ZONE 'UTC'))::bigint AS src_bucket,
         EXTRACT(epoch FROM date_trunc($1, settle_ts AT TIME ZONE 'UTC'))::bigint AS settle_bucket,
         EXTRACT(epoch FROM src_ts)::bigint    AS src_epoch,
         EXTRACT(epoch FROM settle_ts)::bigint AS settle_epoch,
         amount::text, relayer_fee::text
    FROM bridge_messages
   WHERE bridge = ANY($2::text[])
`;

// Per-bucket USD cross-rates for the bridged assets, built the same way as
// TVL_SQL in api/routes/charts.ts: the oracle for BEAM/USD, and for everything
// else the deepest BEAM-paired pool's reserve ratio in that bucket.
const RATE_SQL = `
  WITH oracle_b AS (
    SELECT date_trunc($1, ts AT TIME ZONE 'UTC') AS b, last(beam_usd, ts) AS beam_usd
      FROM oracle_snapshots
     GROUP BY 1
  ),
  pool_b AS (
    SELECT ss.pool_id,
           date_trunc($1, ss.ts AT TIME ZONE 'UTC') AS b,
           last(ss.reserve1, ss.ts)::numeric AS reserve1,
           last(ss.reserve2, ss.ts)::numeric AS reserve2
      FROM pool_state_snapshots ss
     WHERE ss.pool_id IN (
             SELECT pool_id FROM pools WHERE aid1 = 0 AND aid2 = ANY($2::bigint[])
           )
     GROUP BY 1, 2
  ),
  beam_paired AS (
    SELECT DISTINCT ON (pb.b, p.aid2)
           pb.b, p.aid2 AS aid, pb.reserve1, pb.reserve2, a.decimals
      FROM pool_b pb
      JOIN pools  p ON p.pool_id = pb.pool_id
      JOIN assets a ON a.aid = p.aid2
     WHERE pb.reserve1 > 0 AND pb.reserve2 > 0
     ORDER BY pb.b, p.aid2, pb.reserve1 DESC
  )
  SELECT EXTRACT(epoch FROM ob.b)::bigint AS ts, 0 AS aid, ob.beam_usd::float8 AS usd
    FROM oracle_b ob
   WHERE ob.beam_usd IS NOT NULL
   UNION ALL
  SELECT EXTRACT(epoch FROM bp.b)::bigint AS ts, bp.aid::int AS aid,
         ((bp.reserve1 / 1e8::numeric)
           / NULLIF(bp.reserve2 / power(10::numeric, bp.decimals), 0)
           * ob.beam_usd)::float8 AS usd
    FROM beam_paired bp
    JOIN oracle_b ob ON ob.b = bp.b
   WHERE ob.beam_usd IS NOT NULL
   ORDER BY 1
`;

async function ethCustodyDeltas(
  bucket: Bucket,
  cutoff: ReadonlyMap<string, number>,
): Promise<Map<string, Map<number, number>>> {
  const defs = BRIDGES.filter((b) => b.custody === 'eth');
  const out = new Map<string, Map<number, number>>();
  for (const d of defs) out.set(d.key, new Map());
  if (defs.length === 0) return out;

  const { rows } = await q<EthFlowRow>(ETH_FLOW_SQL, [bucket, defs.map((d) => d.key)]);
  for (const row of rows) {
    const def = defs.find((d) => d.key === row.bridge);
    if (!def) continue;
    const until = cutoff.get(def.key);
    if (until === undefined) continue;
    // Amounts are denominated on whichever side the message was observed, so
    // each direction carries its own decimals: bUSDT is 8 on Beam against
    // USDT's 6 on Ethereum, bDAI 8 against DAI's 18.
    const dec = row.direction === 'beam2eth' ? def.decimals : def.ethDecimals;
    const value = (scale(row.amount, dec) ?? 0) + (scale(row.relayer_fee, dec) ?? 0);
    // Junk pushed into the Pipe at around 2^256, not a transfer.
    if (value >= ABSURD) continue;

    const target = out.get(def.key)!;
    const add = (b: number, v: number): void => {
      target.set(b, (target.get(b) ?? 0) + v);
    };

    // Collateral locks on Ethereum when a transfer starts there and releases
    // when a Beam-side transfer settles there. The relayer fee travels with the
    // principal on both legs — dropping it leaves bETH 6% off.
    //
    // Anything that happened after the escrow snapshot is excluded: it is not
    // in the anchor, and counting it would shift every historical point by that
    // transfer's amount while today's figure still looked right.
    if (row.direction === 'eth2beam') {
      if (row.src_bucket !== null && row.src_epoch !== null && Number(row.src_epoch) <= until) {
        add(Number(row.src_bucket), value);
      }
    } else if (
      row.status === 'relayed'
      && row.settle_bucket !== null
      && row.settle_epoch !== null
      && Number(row.settle_epoch) <= until
    ) {
      add(Number(row.settle_bucket), -value);
    }
  }
  return out;
}

async function beamCustodyDeltas(
  def: BridgeDef,
  bucket: Bucket,
  until: number,
): Promise<Map<number, number>> {
  const deltas = await pipeFundsDeltas(def.cid);
  const tsByHeight = await getBlockTsMap(deltas.map((d) => d.height));

  // A positive Funds delta adds to the Pipe's balance; cumulatively summing the
  // column reproduces the Pipe's Locked Funds.
  const groths = new Map<number, bigint>();
  for (const d of deltas) {
    const ts = tsByHeight.get(d.height);
    if (!ts) {
      logger.warn({ cid: def.cid, height: d.height }, 'bridgeTvl: no timestamp for Pipe call height');
      continue;
    }
    // The explorer answers at chain tip while the anchor was measured at the
    // last escrow sync, so the two clocks disagree by up to one indexer tick.
    // `bridge_escrow.block_number` cannot bound this — for every bridge it is an
    // EVM block number, even the Beam-custody ones, so `observed_at` is the only
    // common clock between a Beam height and an Ethereum balance read.
    if (ts.getTime() / MS > until) continue;
    const b = bucketOf(ts, bucket);
    groths.set(b, (groths.get(b) ?? 0n) + d.delta);
  }

  const out = new Map<number, number>();
  for (const [b, total] of groths) out.set(b, scale(total.toString(), def.decimals) ?? 0);
  return out;
}

interface LockedHistory {
  spine: number[];
  /** Native-unit balance per bridge, one value per spine bucket. */
  byBridge: Array<{ def: BridgeDef; locked: number[] }>;
}

async function lockedHistory(bucket: Bucket): Promise<LockedHistory> {
  const escrow = await q<EscrowRow>(
    'SELECT bridge, locked::text, decimals, observed_at FROM bridge_escrow',
  );
  const escrowBy = new Map(escrow.rows.map((r) => [r.bridge, r]));
  const cutoff = new Map(escrow.rows.map((r) => [r.bridge, r.observed_at.getTime() / MS]));

  const beamDefs = BRIDGES.filter((b) => b.custody === 'beam' && cutoff.has(b.key));
  const [ethDeltas, beamDeltas] = await Promise.all([
    ethCustodyDeltas(bucket, cutoff),
    Promise.all(beamDefs.map((d) => beamCustodyDeltas(d, bucket, cutoff.get(d.key)!))),
  ]);

  const deltasBy = new Map(ethDeltas);
  beamDefs.forEach((d, i) => deltasBy.set(d.key, beamDeltas[i]!));

  // Sparse spine: native balances are step functions that only move when the
  // bridge is used, so a bucket with no activity carries no new information.
  const spineSet = new Set<number>([bucketOf(new Date(), bucket)]);
  for (const m of deltasBy.values()) for (const b of m.keys()) spineSet.add(b);
  const spine = [...spineSet].sort((a, b) => a - b);

  const byBridge: LockedHistory['byBridge'] = [];
  for (const def of BRIDGES) {
    const esc = escrowBy.get(def.key);
    if (!esc) {
      // Without a measured anchor the whole series would be an unverifiable
      // guess, so the bridge is left out rather than shown accumulated from zero.
      logger.warn({ bridge: def.key }, 'bridgeTvl: no escrow snapshot; bridge omitted');
      continue;
    }
    const current = scale(esc.locked, esc.decimals);
    if (current === null) continue;

    const deltas = deltasBy.get(def.key) ?? new Map<number, number>();
    const locked = new Array<number>(spine.length).fill(0);
    let running = current;
    for (let i = spine.length - 1; i >= 0; i -= 1) {
      locked[i] = running;
      running -= deltas.get(spine[i]!) ?? 0;
    }

    // What is left after walking past the first bucket is `anchor − Σdeltas`,
    // which must be the balance before the bridge existed: zero. A non-zero
    // residual means the delta set is incomplete, and because the walk is
    // anchored forwards from today, every historical point is wrong by exactly
    // that constant while the present-day figure still matches
    // /api/bridge/health — the one number a reader checks. Loud, because a
    // Parser.wasm rollout renaming a decoded key has broken ingest here before.
    const tolerance = Math.max(10 ** -def.decimals, Math.abs(current) * 1e-9);
    if (Math.abs(running) > tolerance) {
      logger.warn(
        { bridge: def.key, residual: running, anchor: current, tolerance },
        'bridgeTvl: reconstructed flow does not sum to the measured escrow; history is offset',
      );
    }
    const negative = spine.findIndex((_, i) => locked[i]! < -tolerance);
    if (negative >= 0) {
      // Reported, never clamped: a negative balance is impossible on-chain, so
      // it is evidence of a missing delta, and clamping would erase the evidence.
      logger.warn(
        { bridge: def.key, ts: spine[negative], locked: locked[negative] },
        'bridgeTvl: reconstructed balance goes negative',
      );
    }

    byBridge.push({ def, locked });
  }
  return { spine, byBridge };
}

// The explorer round-trips behind the Beam-side reconstruction are the
// expensive part, and the underlying data only moves when the indexer ticks.
const TTL_MS = 60_000;
const cache = new Map<Bucket, { at: number; promise: Promise<LockedHistory> }>();

function loadLockedHistory(bucket: Bucket): Promise<LockedHistory> {
  const hit = cache.get(bucket);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.promise;
  const entry = { at: Date.now(), promise: lockedHistory(bucket) };
  cache.set(bucket, entry);
  return entry.promise.catch((err) => {
    // Never cache a failure — the next caller retries immediately.
    if (cache.get(bucket) === entry) cache.delete(bucket);
    throw err;
  });
}

export async function bridgeTvlByAsset(bucket: Bucket): Promise<{ series: BridgeAssetSeries[] }> {
  const { spine, byBridge } = await loadLockedHistory(bucket);
  return {
    series: byBridge.map(({ def, locked }) => ({
      key: def.key,
      label: def.label,
      decimals: def.decimals,
      points: spine.map((ts, i) => ({ ts, value: locked[i]! })),
    })),
  };
}

// USD TVL moves with the BEAM price every bucket, not only when a bridge is
// used — and the holding is dominated by millions of BEAM. On the sparse spine
// a quiet stretch would render as one straight line across a period the price
// may have doubled in, so the priced series is carried onto every bucket.
function densify(history: LockedHistory, bucket: Bucket): LockedHistory {
  const { spine, byBridge } = history;
  const first = spine[0];
  const last = spine[spine.length - 1];
  if (first === undefined || last === undefined) return history;

  const dense: number[] = [];
  for (let t = first; t <= last; t = nextBucket(t, bucket)) dense.push(t);

  const index: number[] = [];
  let j = 0;
  for (const ts of dense) {
    while (j + 1 < spine.length && spine[j + 1]! <= ts) j += 1;
    index.push(j);
  }

  return {
    spine: dense,
    byBridge: byBridge.map(({ def, locked }) => ({ def, locked: index.map((i) => locked[i]!) })),
  };
}

export async function bridgeTvlSeries(bucket: Bucket): Promise<TvlPoint[]> {
  const { spine, byBridge } = densify(await loadLockedHistory(bucket), bucket);
  const aids = [...new Set(BRIDGES.map((b) => b.aid))];
  const { rows } = await q<{ ts: string; aid: number; usd: number }>(RATE_SQL, [bucket, aids]);

  const ratesBy = new Map<number, Array<{ ts: number; usd: number }>>();
  for (const r of rows) {
    const list = ratesBy.get(r.aid) ?? [];
    list.push({ ts: Number(r.ts), usd: r.usd });
    ratesBy.set(r.aid, list);
  }

  // A bucket often has no rate row of its own, so the last rate at or before it
  // stands in — but only for as long as it can plausibly still be the market
  // price. Before an asset's first rate, and past the hold window, the bridge
  // drops out of that bucket's total rather than being counted as zero, which
  // is the rule /api/bridge/health applies to tvl_usd.
  const maxHold = maxRateHoldSeconds(bucket);
  const cursor = new Map<number, number>();
  const held = new Map<number, { ts: number; usd: number }>();
  const staleLogged = new Set<number>();
  const out: TvlPoint[] = [];

  for (let i = 0; i < spine.length; i += 1) {
    const ts = spine[i]!;
    for (const [aid, list] of ratesBy) {
      let j = cursor.get(aid) ?? 0;
      while (j < list.length && list[j]!.ts <= ts) {
        held.set(aid, list[j]!);
        j += 1;
      }
      cursor.set(aid, j);
      const rate = held.get(aid);
      if (rate !== undefined && ts - rate.ts > maxHold) {
        if (!staleLogged.has(aid)) {
          staleLogged.add(aid);
          logger.warn({ aid, ts, rate_ts: rate.ts }, 'bridgeTvl: cross-rate too stale to carry forward');
        }
        held.delete(aid);
      }
    }

    let total = 0;
    let priced = false;
    for (const { def, locked } of byBridge) {
      const rate = held.get(def.aid);
      if (rate === undefined) continue;
      total += locked[i]! * rate.usd;
      priced = true;
    }
    // Buckets nothing can be priced in carry no information; emitting a zero
    // would draw a plunge to $0 on a TVL chart.
    if (priced) out.push({ ts, value: total });
  }

  return out;
}
