# Architecture

BeamTerminal runs on one VPS. Four long-lived processes (explorer-node, indexer, api, nginx) plus a Postgres container do all the work. Nothing is sharded, queued, or distributed.

## Process layout

```
┌───────────────────────────────────────────────────────────────────────────┐
│  VPS — single host, docker-compose + systemd                              │
│                                                                           │
│  ┌──────────────────────────────────┐      ┌──────────────────────────┐   │
│  │  explorer-node (BEAM binary)     │ poll │  indexer (Node + TS)     │   │
│  │   – embeds a full BEAM node      │ ◀─── │   – polls explorer HTTP  │   │
│  │   – p2p out to mainnet peers     │ HTTP │   – writes to Postgres   │   │
│  │   – own chain DB (~few GB)       │      │   – snapshots pools      │   │
│  │   – loads parser.wasm            │      │   – reorg-aware          │   │
│  │   – public HTTP :8888            │      └────────────┬─────────────┘   │
│  └──────────────────────────────────┘                   │                 │
│                                                          ▼                 │
│                                          ┌──────────────────────────────┐ │
│                                          │  Postgres + TimescaleDB      │ │
│                                          │  :5432  beamterminal db      │ │
│                                          └──────────────┬───────────────┘ │
│                                                          │                 │
│                                                          ▼                 │
│                                          ┌──────────────────────────────┐ │
│                                          │  api (Node + TS, Fastify)    │ │
│                                          │  :3000                       │ │
│                                          │   – /api/*  (UI surface)     │ │
│                                          │   – /cg/*   (CoinGecko spec) │ │
│                                          └──────────────┬───────────────┘ │
│                                                          │                 │
│                                                          ▼                 │
│                                          ┌──────────────────────────────┐ │
│                                          │  nginx :443 / :80            │ │
│                                          │   – TLS termination          │ │
│                                          │   – serves the frontend      │ │
│                                          │   – proxies /api, /cg        │ │
│                                          └──────────────────────────────┘ │
└──────────┬────────────────────────────────────────────────┬───────────────┘
           │ p2p :10000                                     │ HTTPS
           ▼                                                ▼
  ┌────────────────────┐                       ┌─────────────────────────┐
  │ BEAM mainnet peers │                       │ Browser, BEAM Wallet,   │
  │ (eu-node01 / 02…)  │                       │ CoinGecko crawler       │
  └────────────────────┘                       └─────────────────────────┘
```

## Process responsibilities

### `explorer-node` — the chain layer

A single BEAM binary that combines a full node and the HTTP explorer API. Configured with one command:

```
explorer-node --peer eu-node01.mainnet.beam.mw:8100,…  \
              --port 10000                              \
              --api_port 8888                           \
              --contract_rich_parser /path/to/parser.wasm
```

Key facts:

* **One process, two roles**: P2P sync on `:10000`, HTTP API on `:8888`. No separate `beam-node` daemon is required.
* **Own chain DB**, written to the working directory (`explorer-node.db`). First boot syncs the entire chain over P2P — multi-hour, one-time.
* **Loads a monolithic `parser.wasm`** (the pre-modules `--contract_rich_parser` flag — modern BEAM uses a per-module folder; we stick with the simpler single-file form for v1). Without it, contract-call rows come back as raw hex blobs.
* **No ACL**: the HTTP API is publicly reachable. Matches the `explorer.0xmx.net` deployment shape. If you want to gate it later, set `--ip_whitelist`.
* **Binary, not built from source**: we pin a known-good `explorer-node` from a BeamMW CI run / release.

HTTP endpoints we depend on: `/status`, `/block`, `/contract`, `/contracts`, `/assets`, `/asset`. See `backend/src/explorer.ts` for the typed client and observed response shapes.

### Indexer — `backend/src/indexer.ts`

Long-running Node daemon. On a `POLL_INTERVAL_MS` (default 30 s) timer:

1. **Resync the asset catalog** (every 10 minutes, not every tick) via `/assets`, the minter contract's `State.Tokens`, and the extended `/status?exp_am=1` for BEAM's circulating supply. Re-applies imposter flags.
2. **Reorg check** — compare our last-indexed block hash with the chain's current hash at that height. On mismatch, rewind to the common ancestor (see [indexer.md §Reorg handling](indexer.md#reorg-handling)).
3. **Fetch head** — `/status` for height, `/block?height=H` for hash.
4. **Catch up**: if the gap to head exceeds `BACKFILL_PAGE_SIZE` (50 000) blocks, run in **backfill** mode — walk forward in pages, indexing calls only. Otherwise run a **steady tick**:
   * `indexOracle` — write a new `oracle_snapshots` row.
   * `snapshotPoolStates` — for every pool, upsert reserves into `pool_state_snapshots`.
   * `indexCalls(last+1, head)` — fetch `/contract?id=DEX&state=0&hMin=…&hMax=…&nMaxTxs=2000`, parse trades / liquidity events / pool create+destroy.
   * `promoteToConfirmed` — flip `confirmed = TRUE` on trades / lp_events that have reached `CONFIRMATIONS` depth (80).
   * `updateCursor(head, headHash)`.
5. **Refresh slow caches** in the background (e.g. `dex_stats.total_volume_usd`) — see [database.md §dex_stats cache](database.md#dex_stats-cache).

The indexer never writes Postgres concurrently with itself: one tick at a time, sequential. That keeps reorg recovery simple — no inflight writes to reconcile.

### API — `backend/src/api.ts`

Stateless Fastify service. Reads Postgres only.

* **`/api/*`** — the UI surface. Shape evolves with the React app's needs. CORS open. Cache-Control headers per route (typically `public, max-age=15`–`30`).
* **`/cg/*`** — CoinGecko-spec endpoints. Numeric fields as decimal strings, imposter pools and destroyed pools excluded. See [CoinGecko.md](CoinGecko.md).
* **Rate limiting** — `@fastify/rate-limit`, `RATE_LIMIT_PER_MIN` (default 600/IP). Set to 0 to disable.
* **Wallet quote path**: the API does **not** quote swaps. Swap quotes live in the AMM shader inside the user's wallet (`bPredictOnly=1`) — see [frontend.md §Wallet integration](frontend.md#wallet-integration).
* **Logging**: pino, one line per request at debug level; warnings/errors at higher levels.

### Postgres + TimescaleDB

Single instance, single database `beamterminal`. Schema lives in `backend/migrations/*.sql`, applied in lexical order by `scripts/migrate.ts` with an idempotent `schema_migrations` table.

Tables and their roles, at a glance:

* **`assets`** — every AID we've ever seen. Imposter flags, decimals, descriptive metadata, supply caps.
* **`pools`** — `(aid1, aid2, kind)` is the natural key. `aid_ctl` is the LP token AID.
* **`trades`**, **`lp_events`**, **`pool_state_snapshots`**, **`oracle_snapshots`** — hypertables on `block_ts`.
* **`block_timestamps`** — cache of height → wall-clock time, populated lazily by the indexer.
* **`cursor`** — single-row indexer state (last height + hash + last-aggregates-refresh marker).
* **`dex_stats`** — single-row cache for slow API aggregates that won't fit in a per-request budget.
* **`candles_1m … candles_1d`**, **`liquidity_1h`** — continuous aggregates.

Full schema reference: [database.md](database.md).

### nginx

* TLS termination via Let's Encrypt.
* Serves the static React bundle from `/var/www/beamterminal`.
* Reverse-proxies `/api/*` and `/cg/*` to `localhost:3000`.

## Data flow

### Cold path — initial backfill

1. Indexer starts with `cursor.last_indexed_height = 0`.
2. Reads `DEX_DEPLOY_HEIGHT` from env (or falls back to scanning `/contracts` to discover it). On mainnet today: `2270704`.
3. Snapshots the current pool set **before** walking any calls — otherwise `resolvePoolId()` returns null and trades get silently dropped.
4. Walks `[deploy, head]` in 50 000-block pages. Each page calls `/contract?state=0` with `nMaxTxs=2000` and parses trades / LP events / pool lifecycle into the DB.
5. After the last page, fires `refresh_continuous_aggregate(view, NULL, NULL)` for every candle and liquidity view — the auto-refresh policies only cover the last few weeks, so historical buckets need a manual one-shot refresh.
6. Stamps `cursor.aggregates_refreshed_at_height = head` so a crash mid-backfill triggers a re-refresh on next start.

### Hot path — steady state

1. Wake on the 30 s timer.
2. Reorg check (cheap; one `/block?height=H` round-trip).
3. Fetch head height + hash.
4. Oracle → pool snapshot → call ingest → confirmation promotion → cursor advance.
5. Continuous aggregates auto-refresh on their own schedule (1 min for `candles_1m`, 1 h for `candles_1h`, etc.). The 80-block confirmation window is well inside every refresh policy's `start_offset`, so promotions and reorg rewrites always land inside the refresh range.

### UI reads (anonymous, in browser)

* `/api/stats` — polled every 60 s.
* `/api/pairs` — fetched on mount and on user-triggered sort/filter; not auto-polled.
* `/api/pairs/{id}` — re-fetched every 30 s on the detail page.
* `/api/pairs/{id}/ohlcv` — initial load + on toolbar change + on chart scroll-back (cursor-based via `more.to`).
* `/api/pairs/{id}/trades` — initial load + 30 s top-of-feed refresh that splices new trades onto the head.

### UI reads (inside the BEAM Wallet)

Same React bundle, just running under the wallet's QtWebEngine. The polling cadence above still drives the UI; the wallet is involved only for swap actions (predict + execute via `pool_trade`). A future v1.x can opt into `BeamDappConnector.subscribe('ev_system_state', …)` for per-block refresh; v1 stays polling-only for simplicity.

### CoinGecko ingestion

* CG's crawler hits `/cg/tickers` and `/cg/historical_trades/{ticker_id}` on a minutely cadence.
* Same Postgres rows feed `/api/*` and `/cg/*`; the `/cg/*` handlers add the imposter/destroyed/zero-liquidity filters CG expects and shape fields per their spec.

## What's deliberately absent

* **No Redis** — the in-process route cache (via `Cache-Control` headers) plus Postgres covers our load.
* **No message queue** — the indexer writes directly to Postgres. Inserts are idempotent: every hot table has a natural-key unique index (`trades_natural_key_idx`, `lp_events_natural_key_idx`) so re-ingesting an already-seen window does nothing.
* **No worker pool** — single indexer process. Vertical scale first; we won't outrun one Node process at BEAM volumes for years.
* **No public WebSocket** — REST is sufficient for v1.

## Failure modes

| Failure | Behavior | Operator action |
|---|---|---|
| `explorer-node` lags behind mainnet | `/status` returns a stale height; indexer keeps polling and catches up. UI banner shows "stale data" if last block ts is > 5 min old. | None — the systemd unit restarts on crash. |
| `explorer-node` crashes | Indexer logs warnings every tick with exponential backoff; API keeps serving stale data. | `systemctl status explorer-node`. |
| Indexer crashes | systemd restarts it. Resumes from `cursor.last_indexed_height`. | If the crash happened mid-backfill, the next start auto re-runs `refresh_continuous_aggregate(..., NULL, NULL)` because `aggregates_refreshed_at_height < last_indexed_height`. |
| Postgres down | API returns 503 (`/api/health` flips to `degraded`). Indexer ticks fail with logged errors and retry on the next interval. | Restart the container; nothing to recover by hand. |
| Reorg deeper than 80 blocks | Indexer rewinds to the common ancestor (binary-search backward), deletes `trades` / `lp_events` / `pool_state_snapshots` / `block_timestamps` past that height, un-marks `pools.destroyed_at_height` for anything affected. Continuous aggregates self-correct on the next refresh. | None — fully automated. |
| Oracle stalls (no feeds within validity) | `oracle_snapshots` stops growing. USD numbers in the UI dark out; `/cg/tickers` still serves but `liquidity_in_usd` may be stale. | Investigate why the on-chain feeds stopped publishing — outside our system. |

## Configuration surface

Everything lives in `backend/.env`, validated by `zod` (see `backend/src/config.ts`).

```
# Database (host port 5433 by default to avoid conflicting with a system Postgres)
DATABASE_URL=postgres://beamterminal:…@localhost:5433/beamterminal

# Explorer
EXPLORER_URL=http://localhost:8888           # prod: local explorer-node
# EXPLORER_URL=https://explorer.0xmx.net/api # dev: public explorer

# Contracts (mainnet)
DEX_CID=729fe098d9fd2b57705db1a05a74103dd4b891f535aef2ae69b47bcfdeef9cbf
DEX_DEPLOY_HEIGHT=2270704
ORACLE_CID=4f160f01dcc6751e61d793279b803328d5332125fe8492e93ee8f3bfe9abe13b
ASSET_MINTER_CID=295fe749dc12c55213d1bd16ced174dc8780c020f59cb17749e900bb0c15d868

# Indexer
CONFIRMATIONS=80
POLL_INTERVAL_MS=30000

# API
API_PORT=3000
API_HOST=127.0.0.1
RATE_LIMIT_PER_MIN=600

# Logging
LOG_LEVEL=info
NODE_ENV=production
```

`ASSET_MINTER_CID` is optional — leave unset to skip per-asset supply-cap sync.
