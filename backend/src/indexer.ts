import { config } from './config.js';
import { logger } from './logger.js';
import { pool, q, shutdown } from './db.js';
import { getStatus, getContract, getBlock } from './explorer.js';
import { extractOracleSnapshot, OracleMedianUnavailable } from './parsers/oracle.js';
import { getBlockTs } from './services/blockTimestamps.js';
import { syncAssetsCatalog } from './services/assets.js';
import { syncMinterTokens } from './services/minter.js';
import { syncBeamSupply } from './services/beamSupply.js';
import { snapshotPoolStates } from './services/pools.js';
import { indexCalls, promoteToConfirmed } from './services/calls.js';
import { findDexDeployHeight } from './services/backfill.js';
import { detectAndHealReorg, updateCursor } from './services/reorg.js';
import { seedImposters } from './imposters.js';
import { refreshDexStats } from './services/dexStats.js';
import { ingestRange as ingestBlockMetricsRange, maxIndexedHeight as maxBlockMetricsHeight } from './services/blockMetrics.js';
import { syncAssetSwapOffers } from './services/assetSwapOffers.js';
import { syncAtomicSwapOffers, snapshotAtomicSwapTotals } from './services/atomicSwaps.js';
import { syncDappStore } from './services/dappStore.js';
import { syncIpfsPins } from './services/ipfsPin.js';

let stopping = false;

// How wide each backfill page is. Tunable via env later if needed.
const BACKFILL_PAGE_SIZE = 50_000;

// How often we re-sync the /assets catalog. 10 min.
const ASSETS_RESYNC_MS = 10 * 60 * 1000;
let lastAssetsSync = 0;

// Per-tick cap for the block_metrics catch-up loop. Bounds explorer load when
// we're far behind (e.g. after a fresh deploy). At 30s ticks × 200 blocks =
// ~24k blocks/hour; full-chain (~3.6M blocks) catches up in ~6 days.
// Operators with their own explorer-node should raise this and/or run
// scripts/backfill-block-metrics.ts.
const BLOCK_METRICS_PER_TICK = 200;
let blockMetricsInflight = false;

// How often we recompute the slow /api/stats aggregates (currently just
// total_volume_usd). The full-trades CTE is too slow to run per-request
// behind CF Tunnel's ~100s edge timeout. 5 min.
const DEX_STATS_REFRESH_MS = 5 * 60 * 1000;
let lastDexStatsRefresh = 0;
let dexStatsRefreshInflight = false;

// Asset-swap offers (wallet-api). Independent of the main tick — runs at its
// own cadence so a slow wallet-api can't stall DEX call ingest. No-ops when
// WALLET_API_URL is unset.
let lastAssetSwapsSync = 0;
let assetSwapsInflight = false;

// Atomic-swap mirror runs once per tick (cheap, two HTTP calls).
let atomicSwapsInflight = false;

// DApp Store ingest resyncs at the assets-catalog cadence (10 min). Call
// volume is tiny — no need to do it every tick.
const DAPP_STORE_RESYNC_MS = 10 * 60 * 1000;
let lastDappStoreSync = 0;
let dappStoreInflight = false;

// IPFS pin sweep. Walks dapps + dapp_versions for rows whose CID we haven't
// pinned yet on our wallet-api node and pins them. Faster cadence than the
// dapp-store sync itself (3 min) so a newly-indexed dapp gets pinned within
// a couple of ticks. The sweep is a no-op once the backlog is drained.
const IPFS_PIN_RESYNC_MS = 3 * 60 * 1000;
let lastIpfsPinSync = 0;
let ipfsPinInflight = false;

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

async function readCursor(): Promise<number> {
  const { rows } = await q<{ last_indexed_height: string }>(
    'SELECT last_indexed_height FROM cursor WHERE id = 1',
  );
  if (rows.length === 0) {
    throw new Error('cursor row missing — did migrations run?');
  }
  return Number(rows[0]!.last_indexed_height);
}

async function readAggregatesMarker(): Promise<number> {
  const { rows } = await q<{ h: string }>(
    'SELECT aggregates_refreshed_at_height AS h FROM cursor WHERE id = 1',
  );
  return rows[0] ? Number(rows[0].h) : 0;
}

async function bumpAggregatesMarker(height: number): Promise<void> {
  await q(
    'UPDATE cursor SET aggregates_refreshed_at_height = $1 WHERE id = 1 AND aggregates_refreshed_at_height < $1',
    [height],
  );
}

// ---------------------------------------------------------------------------
// Per-tick steps
// ---------------------------------------------------------------------------

async function indexOracle(headHeight: number): Promise<void> {
  const resp = await getContract({ id: config.ORACLE_CID, state: true, nMaxTxs: 0 });
  let snapshot;
  try {
    snapshot = extractOracleSnapshot(resp);
  } catch (err) {
    if (err instanceof OracleMedianUnavailable) {
      logger.warn({ height: headHeight }, 'oracle median unavailable; skipping');
      return;
    }
    throw err;
  }

  await q(
    `INSERT INTO oracle_snapshots (ts, height, beam_usd, h_end)
     VALUES (now(), $1, $2, $3)
     ON CONFLICT (ts) DO UPDATE SET
       height   = EXCLUDED.height,
       beam_usd = EXCLUDED.beam_usd,
       h_end    = EXCLUDED.h_end`,
    [headHeight, snapshot.beam_usd, snapshot.h_end],
  );

  logger.debug(
    { height: headHeight, beam_usd: snapshot.beam_usd, feeds_active: snapshot.feeds.filter((f) => !f.is_outdated).length },
    'oracle snapshot written',
  );
}

// Kick off a background refresh of the dex_stats cache if stale. Fire-and-forget
// so a long-running aggregate query doesn't stall the tick loop; the in-flight
// flag prevents stacking concurrent refreshes when one run outlasts an interval.
function maybeKickDexStatsRefresh(): void {
  if (dexStatsRefreshInflight) return;
  const now = Date.now();
  if (now - lastDexStatsRefresh < DEX_STATS_REFRESH_MS) return;
  dexStatsRefreshInflight = true;
  refreshDexStats()
    .then(() => { lastDexStatsRefresh = Date.now(); })
    .catch((err) => {
      logger.warn(
        { err: err instanceof Error ? err.message : err },
        'dex_stats refresh failed; will retry next tick',
      );
    })
    .finally(() => { dexStatsRefreshInflight = false; });
}

// Fire-and-forget catch-up of the block_metrics hypertable. We deliberately
// don't await this in the tick body — at most BLOCK_METRICS_PER_TICK explorer
// calls per pass, and a long catch-up window must not delay DEX call ingest.
function maybeKickBlockMetricsCatchUp(headHeight: number): void {
  if (blockMetricsInflight) return;
  blockMetricsInflight = true;
  (async () => {
    const current = (await maxBlockMetricsHeight()) ?? 0;
    if (current >= headHeight) return;
    const from = current + 1;
    const to = Math.min(from + BLOCK_METRICS_PER_TICK - 1, headHeight);
    const inserted = await ingestBlockMetricsRange(from, to);
    logger.info({ from, to, inserted, head: headHeight }, 'block_metrics catch-up');
  })()
    .catch((err) => {
      logger.warn(
        { err: err instanceof Error ? err.message : err },
        'block_metrics catch-up failed; will retry next tick',
      );
    })
    .finally(() => { blockMetricsInflight = false; });
}

// Fire-and-forget poll of the wallet-api for asset-swap offers. Independent
// cadence so DEX ingest never waits on a slow wallet daemon.
function maybeKickAssetSwapsSync(): void {
  if (assetSwapsInflight) return;
  const now = Date.now();
  if (now - lastAssetSwapsSync < config.ASSET_SWAP_POLL_MS) return;
  assetSwapsInflight = true;
  syncAssetSwapOffers()
    .then((res) => {
      lastAssetSwapsSync = Date.now();
      if (res) logger.debug(res, 'asset swap offers synced');
    })
    .catch((err) => {
      logger.warn(
        { err: err instanceof Error ? err.message : err },
        'asset swap offers sync failed; will retry next tick',
      );
    })
    .finally(() => { assetSwapsInflight = false; });
}

// Atomic-swap offers + totals (explorer-driven). Cheap and synchronous-ish; we
// still gate to avoid stacking when an explorer request hangs.
function maybeKickAtomicSwapsSync(headHeight: number): void {
  if (atomicSwapsInflight) return;
  atomicSwapsInflight = true;
  (async () => {
    await syncAtomicSwapOffers();
    await snapshotAtomicSwapTotals(headHeight);
  })()
    .catch((err) => {
      logger.warn(
        { err: err instanceof Error ? err.message : err },
        'atomic swap sync failed; will retry next tick',
      );
    })
    .finally(() => { atomicSwapsInflight = false; });
}

// DApp Store registry ingest. Runs the local app-shader (`dapps_store_app.wasm`)
// against the live contract via wallet-api `invoke_contract`. No headHeight
// argument: the shader reads chain state at the wallet's tip.
function maybeKickDappStoreSync(): void {
  if (dappStoreInflight) return;
  if (!config.DAPP_STORE_CID) return;
  if (!config.WALLET_API_URL) return; // wasm execution needs the daemon
  const now = Date.now();
  if (now - lastDappStoreSync < DAPP_STORE_RESYNC_MS) return;
  dappStoreInflight = true;
  syncDappStore()
    .then((res) => {
      lastDappStoreSync = Date.now();
      if (res) logger.info(res, 'dapp-store synced');
    })
    .catch((err) => {
      logger.warn(
        { err: err instanceof Error ? err.message : err },
        'dapp-store sync failed; will retry next tick',
      );
    })
    .finally(() => { dappStoreInflight = false; });
}

function maybeKickIpfsPinSync(): void {
  if (ipfsPinInflight) return;
  if (!config.WALLET_API_URL) return; // pin RPC needs the daemon
  const now = Date.now();
  if (now - lastIpfsPinSync < IPFS_PIN_RESYNC_MS) return;
  ipfsPinInflight = true;
  syncIpfsPins()
    .then((res) => {
      lastIpfsPinSync = Date.now();
      if (res) logger.info(res, 'ipfs-pin batch');
    })
    .catch((err) => {
      logger.warn(
        { err: err instanceof Error ? err.message : err },
        'ipfs-pin sync failed; will retry next tick',
      );
    })
    .finally(() => { ipfsPinInflight = false; });
}

async function maybeSyncAssetsCatalog(): Promise<void> {
  const now = Date.now();
  if (now - lastAssetsSync < ASSETS_RESYNC_MS) return;
  try {
    await syncAssetsCatalog();
    // Enrich minter-issued assets with their configured supply cap. Runs after
    // the catalog sync so freshly-inserted AIDs are present before UPDATEs land.
    // No-ops when ASSET_MINTER_CID is unset.
    await syncMinterTokens();
    // BEAM (aid 0) isn't in the /assets registry — pull its circulating + cap
    // from the explorer's extended /status totals so the asset detail page
    // can render the same numbers as the BEAM explorer.
    await syncBeamSupply();
    // Re-apply imposter flags after catalog sync (sync resets `last_updated_at`
    // and may have inserted previously-unseen AIDs that happen to be imposters).
    await seedImposters();
    lastAssetsSync = now;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err },
      'assets catalog sync failed; will retry next tick',
    );
  }
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

/**
 * Walk forward from `cursor.last_indexed_height` to the head in fixed-size
 * pages. Pool snapshots happen once at the end (we don't snapshot per page —
 * it'd just rewrite the same final state).
 */
async function backfill(headHeight: number, headTs: Date): Promise<void> {
  let from = await readCursor();

  if (from === 0) {
    // Prefer the operator-provided deploy height (DEX_DEPLOY_HEIGHT in env).
    // Falling back to /contracts costs an explorer roundtrip and breaks if
    // the contract isn't listed there.
    let deploy = config.DEX_DEPLOY_HEIGHT ?? 0;
    if (deploy <= 0) {
      deploy = await findDexDeployHeight();
    }
    if (deploy <= 0) {
      // Falling back to "tip - N blocks" silently truncates history — we'd
      // miss every trade prior to the window. Hard-fail so the operator
      // notices and sets DEX_DEPLOY_HEIGHT (or fixes the explorer access).
      throw new Error(
        'cannot start backfill: DEX deploy height unknown. ' +
        'Set DEX_DEPLOY_HEIGHT in env, or fix EXPLORER_URL / DEX_CID so /contracts lists it.',
      );
    }
    from = deploy - 1; // we'll start indexing at deploy
    logger.info({ deploy_height: deploy, start: from }, 'backfill starting from DEX deploy');
  }

  // Snapshot the current pool set BEFORE walking any calls — otherwise
  // resolvePoolId() returns null for every trade and we silently drop them.
  // This captures all pools currently in existence; pools created+destroyed
  // entirely within the backfill window are not represented (acceptable for v1).
  await snapshotPoolStates(headHeight, headTs);

  const totalSpan = Math.max(headHeight - from, 1);
  const startedAt = Date.now();
  const startFrom = from;

  while (from < headHeight && !stopping) {
    const to = Math.min(from + BACKFILL_PAGE_SIZE, headHeight);
    const pct = ((to - startFrom) / totalSpan) * 100;
    const elapsedMs = Date.now() - startedAt;
    const heightsDone = to - startFrom;
    const heightsLeft = headHeight - to;
    const etaSec = heightsDone > 0
      ? Math.round((elapsedMs / heightsDone) * heightsLeft / 1000)
      : null;
    logger.info({ from: from + 1, to, pct: +pct.toFixed(2), eta_seconds: etaSec }, 'backfill page');
    const counts = await indexCalls(from + 1, to);
    logger.info(
      { from: from + 1, to, pct: +pct.toFixed(2), eta_seconds: etaSec, ...counts },
      'backfill page done',
    );
    // No per-page hash during backfill; head-hash is captured on the next
    // steady-state tick. This is fine because reorgs only matter near the tip.
    await updateCursor(to, undefined);
    from = to;
  }

  if (!stopping) {
    await refreshAllAggregates();
  }
}

/**
 * Materialize the entire history of every continuous aggregate.
 *
 * The auto-refresh policies only cover `start_offset`-deep windows (longest is
 * 90 days for `candles_1d`). After a full backfill from DEX genesis, this one
 * call ensures buckets for older trades exist — otherwise the UI sees only
 * the last few weeks even though the underlying `trades` table is complete.
 *
 * `refresh_continuous_aggregate(..., NULL, NULL)` must be called outside a
 * transaction; `pg` issues each query as its own statement, so this works.
 */
async function refreshAllAggregates(): Promise<void> {
  const views = [
    'candles_1m', 'candles_5m', 'candles_15m',
    'candles_1h', 'candles_4h', 'candles_1d',
    'liquidity_1h',
  ];
  for (const v of views) {
    const t0 = Date.now();
    await q(`CALL refresh_continuous_aggregate('${v}', NULL, NULL)`);
    logger.info({ view: v, ms: Date.now() - t0 }, 'continuous aggregate refreshed');
  }
  // Stamp the cursor with the height at refresh completion. A crash before
  // this line forces another full refresh next startup.
  const head = await readCursor();
  await bumpAggregatesMarker(head);
  logger.info({ height: head }, 'aggregates marker advanced');
}

/**
 * Run on indexer startup: if the marker lags `last_indexed_height`, the
 * previous process crashed mid-backfill or before the post-backfill refresh.
 * Re-run the full materialization so the chart sees every bucket.
 */
async function catchUpAggregatesIfNeeded(): Promise<void> {
  const last = await readCursor();
  if (last === 0) return; // nothing indexed yet
  const marker = await readAggregatesMarker();
  if (marker >= last) return; // up to date
  logger.warn(
    { last_indexed_height: last, aggregates_marker: marker },
    'continuous aggregates stale (likely from interrupted backfill); refreshing',
  );
  await refreshAllAggregates();
}

async function steadyTick(headHeight: number, headTs: Date, headHash: string | undefined): Promise<void> {
  const last = await readCursor();
  if (headHeight <= last) {
    logger.debug({ head: headHeight, last }, 'no new blocks');
    return;
  }

  logger.info({ from: last + 1, to: headHeight }, 'indexing window');

  // Oracle first — cheapest, sets BEAM/USD for downstream display.
  await indexOracle(headHeight);

  // Pool snapshot BEFORE indexCalls so resolvePoolId can find every pool.
  // (snapshotPoolStates auto-upserts pool rows for every pool currently on-chain.)
  await snapshotPoolStates(headHeight, headTs);

  // AMM contract calls in [last+1, headHeight].
  const counts = await indexCalls(last + 1, headHeight);

  // Promote anything past the confirmation depth.
  const promoted = await promoteToConfirmed(headHeight);

  await updateCursor(headHeight, headHash);
  // Don't touch the aggregates marker here. In steady state the continuous
  // aggregate refresh policies + real-time aggregation handle the recent
  // window. The marker exists to record "refreshAllAggregates completed for
  // the full history up to this height" — only refreshAllAggregates may
  // advance it. Bumping it from steady-state would mask an interrupted
  // backfill (where refreshAllAggregates never ran) and leave the views
  // permanently empty.

  logger.info(
    { from: last + 1, to: headHeight, ...counts, promoted },
    'tick done',
  );
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

async function tick(): Promise<void> {
  await maybeSyncAssetsCatalog();
  maybeKickDexStatsRefresh();
  // These three are independent of the chain head and self-rate-limited;
  // kick them every tick — each one bails fast when it's not yet due.
  maybeKickAssetSwapsSync();

  // Reorg check BEFORE any new ingest. If the chain rewrote our last-indexed
  // block, the cursor (and tables) get rewound to a common ancestor first.
  await detectAndHealReorg();

  const status = await getStatus();
  // Stamp the observed chain head so /api/health can render a lag badge
  // without doing its own explorer round-trip.
  await q('UPDATE cursor SET last_chain_head = $1 WHERE id = 1', [status.height]);
  maybeKickBlockMetricsCatchUp(status.height);
  maybeKickAtomicSwapsSync(status.height);
  maybeKickDappStoreSync();
  // Pin newly-indexed dapps on our wallet-api node so /ipfs/<cid> and
  // /api/dapp/:cid keep working even when the original publisher's IPFS
  // node goes offline. Self-paced, drains the backlog in MAX_PINS_PER_TICK
  // chunks. Cheap when there's no backlog.
  maybeKickIpfsPinSync();
  const headTs = await getBlockTs(status.height);
  // Fetch head block to get the kernel hash for cursor persistence.
  const headBlock = await getBlock({ height: status.height });
  const headHash = headBlock.hash;

  const last = await readCursor();
  // If we're a long way behind, run in backfill mode (calls only, no per-page
  // pool snapshots or oracle inserts — those are expensive and overwritten
  // by the steady-state tick that follows).
  if (status.height - last > BACKFILL_PAGE_SIZE) {
    await backfill(status.height, headTs);
    return;
  }

  await steadyTick(status.height, headTs, headHash);
}

async function loop(): Promise<void> {
  logger.info(
    {
      explorer_url: config.EXPLORER_URL,
      dex_cid: config.DEX_CID,
      oracle_cid: config.ORACLE_CID,
      poll_interval_ms: config.POLL_INTERVAL_MS,
      confirmations: config.CONFIRMATIONS,
    },
    'indexer starting',
  );

  try {
    await catchUpAggregatesIfNeeded();
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : err },
      'startup aggregate catch-up failed; continuing',
    );
  }

  while (!stopping) {
    try {
      await tick();
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : err }, 'tick failed');
    }
    await sleep(config.POLL_INTERVAL_MS);
  }

  logger.info('indexer stopped');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(t);
      process.off('SIGINT', onStop);
      process.off('SIGTERM', onStop);
      resolve();
    };
    const onStop = (): void => done();
    const t = setTimeout(done, ms);
    if (stopping) {
      done();
      return;
    }
    process.on('SIGINT', onStop);
    process.on('SIGTERM', onStop);
  });
}

function installSignalHandlers(): void {
  const handler = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutdown requested');
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
}

installSignalHandlers();

loop()
  .catch((err) => {
    logger.fatal({ err: err instanceof Error ? err.message : err }, 'fatal');
    process.exitCode = 1;
  })
  .finally(async () => {
    await shutdown();
    void pool; // touch the import so it isn't tree-shaken
  });
