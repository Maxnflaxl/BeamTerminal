# Indexer

The indexer is a long-running Node + TypeScript daemon (`backend/src/indexer.ts`) that turns the BEAM `explorer-node`'s HTTP responses into rows in Postgres + TimescaleDB. It is the source of truth for "what's a trade?", "what's a confirmed trade?", and "what's the BEAM/USD reference price right now?".

## What the explorer gives us

Three endpoints carry all the data we need.

### `GET /contract?id=<DEX_CID>&state=1`

Current state of every pool. Used for `pool_state_snapshots` on every tick.

```jsonc
{
  "kind": "DEX v0",
  "h": 3863503,
  "State": {
    "Pools": {
      "type": "table",
      "value": [
        // header (typed-cell row)
        [{"type":"th","value":"Aid1"},{"type":"th","value":"Aid2"},
         {"type":"th","value":"Volatility"},{"type":"th","value":"LP-Token"},
         {"type":"th","value":"Amount1"},{"type":"th","value":"Amount2"},
         {"type":"th","value":"Amount-LP-Token"},
         {"type":"th","value":"Rate 1:2"},{"type":"th","value":"Rate 2:2"}],
        // data row: BEAM/aid2/High tier
        [{"type":"aid","value":0},{"type":"aid","value":2},"High",
         {"type":"aid","value":55},
         {"type":"amount","value":2512943296},
         {"type":"amount","value":27446233753},
         {"type":"amount","value":8040484862},
         "9.1558766 E-2","10.921947"]
      ]
    }
  }
}
```

Quirks worth knowing (parser handles all of them — `backend/src/parsers/amm.ts:parsePoolsTable`):

* Cells are heterogeneous: numeric AIDs and amounts come wrapped (`{type:"aid",value:N}`, `{type:"amount",value:N|string}`), but `Volatility` is a bare string (`"Low"`/`"Medium"`/`"High"`) and the two `Rate` columns are formatted decimal strings, sometimes with a literal space before the exponent (`"9.1558766 E-2"`).
* `Volatility` maps to `kind`: Low → 0 (0.05% fee), Medium → 1 (0.30%), High → 2 (1.00%).
* Amounts are in **groths** (BEAM has 8 decimals everywhere). Several can exceed `Number.MAX_SAFE_INTEGER`; parsed as `BigInt`, stored as `NUMERIC(40, 0)`.
* Pool well-ordering is `aid1 < aid2`, enforced by the contract. The indexer assumes and validates this.

### `GET /contract?id=<DEX_CID>&state=0&hMin=…&hMax=…&nMaxTxs=2000`

The call list within a height range. Each entry is either a flat row (single primary call) or a `{type:"group", value:[…]}` wrapper grouping a primary call with the nested calls it triggered.

Verified header on mainnet (8 cells per row — the explorer's table header advertises 7 but the rows always carry 8; the 7th cell is `Emission`, unlabeled):

```
[Height, Cid, Kind, Method, Arguments, Funds, Emission, Keys]
```

Sample wrapped Trade row (the `Trade` primary call plus its nested `DaoVault Deposit` fee skim):

```jsonc
{
  "type": "group",
  "value": [
    [3862812, "", "", "Trade",
     {"Aid1": {"type":"aid","value":47},
      "Aid2": {"type":"aid","value":0},
      "Volatility": "High"},
     {"type":"table","value":[
       [{"type":"aid","value":0},  {"type":"amount","value":"+103161261998"}],
       [{"type":"aid","value":47}, {"type":"amount","value":"-2000000000"}]
     ]},
     "", ""],
    [/* nested DaoVault Deposit — we ignore everything past index 0 */]
  ]
}
```

Conventions:

* **Funds sign** is from the *contract's* perspective. `"+N"` = the contract gained N (user paid in); `"-N"` = the contract lost N (user received out). Always parse as BigInt; many strings exceed JS-number precision.
* **A `Trade` row** has exactly two non-zero funds: one positive (user's `aid_in`), one negative (user's `aid_out`).
* **A `Liquidity Add`** has two positive Funds entries (both legs paid in) and one positive Emission entry (LP tokens minted).
* **A `Liquidity Withdraw`** is the inverse (Funds negative, Emission negative — LP burned).
* **Nested calls are ignored** — `value[0]` is the primary, `value[1..]` is supporting accounting (e.g. the 30 % protocol fee deposit into DaoVault) that isn't user-facing. Detect by position-in-group, not by `Cid === ""` (flat rows also have empty Cid).
* **Method strings we handle**: `Trade`, `Liquidity Add`, `Liquidity Withdraw`, `Pool Create`, `Pool Destroy`. Everything else (`Create`, `Destroy`, `Upgradable3 Control`) is filtered.
* **Argument canonicalization**: call arguments aren't necessarily well-ordered (mainnet has both orderings). The parser sorts `(rawAid1, rawAid2) → (min, max)` so downstream `resolvePoolId` lookups always succeed.

### `GET /contract?id=<ORACLE_CID>&state=1`

The BEAM/USD oracle. The Oracle2 parser shader is installed on mainnet, so the response carries `State.Median` as a pre-decoded decimal string — no FloatLegacy decoding required.

```jsonc
{
  "kind": "Oracle2 v0",
  "h": 3863503,
  "State": {
    "Median": "0.021750367",
    "Settings": {"Min Providers": 3, "Validity Period": 220, …},
    "Feeds": {
      "type": "table",
      "value": [
        [/* header */],
        [0, {"type":"blob","value":"…pubkey…"}, "0.0557",  {"type":"height","value":3155559}, "outdated"],
        [2, {"type":"blob","value":"…pubkey…"}, "0.02027", {"type":"height","value":3863467}, ""]
      ]
    }
  }
}
```

We parse:

* `State.Median` → `oracle_snapshots.beam_usd` (decimal string → `NUMERIC(20, 8)`). If `Median` is missing (fewer providers than `Min Providers`), the parser throws `OracleMedianUnavailable` and the tick logs a warning instead of failing.
* The highest `Last Height` across **non-outdated** feeds → `oracle_snapshots.h_end`. This approximates the on-chain `Median.m_hEnd` (which the parser shader doesn't expose directly) — useful for staleness detection.
* `Settings."Validity Period"` (220 blocks ≈ 3.5 h on mainnet) is the contract's own staleness threshold; the UI uses it to grey out USD numbers when every feed is past validity.

See `backend/src/parsers/oracle.ts`.

## Indexer loop — concrete shape

```
ON START:
  catchUpAggregatesIfNeeded()        # re-refresh continuous aggregates if a prior backfill was interrupted
  loop forever:
    maybeSyncAssetsCatalog()         # every 10 min: /assets + /minter + /status?exp_am=1 + imposters
    maybeKickDexStatsRefresh()       # fire-and-forget background recompute of slow total_volume_usd
    detectAndHealReorg()             # binary-search back to common ancestor on hash mismatch
    head = GET /status .height
    headTs = blockTimestamp(head)
    headHash = (GET /block?height=head).hash
    if head - cursor.last_indexed_height > BACKFILL_PAGE_SIZE (50_000):
      backfill(head, headTs)
    else:
      steadyTick(head, headTs, headHash)
    sleep(POLL_INTERVAL_MS)
```

### `backfill(head, headTs)`

```
from = cursor.last_indexed_height
if from == 0:
  from = (env DEX_DEPLOY_HEIGHT) or findDexDeployHeight()   # hard-fail if both unavailable
  snapshotPoolStates(head, headTs)                          # ensure resolvePoolId() succeeds
while from < head:
  to = min(from + 50_000, head)
  indexCalls(from + 1, to)                                  # writes to trades / lp_events / pools
  updateCursor(to, undefined)                               # no hash mid-backfill — reorg only matters near tip
  from = to
refreshAllAggregates()                                      # full refresh_continuous_aggregate(view, NULL, NULL)
```

The backfill mode skips per-page pool snapshots and per-page oracle inserts; those are overwritten by the steady-state tick that follows. The pool snapshot up front captures the current pool set so trades inside the backfill window can be matched to a `pool_id`.

### `steadyTick(head, headTs, headHash)`

```
indexOracle(head)                  # write oracle_snapshots row
snapshotPoolStates(head, headTs)   # upsert per-pool reserves into pool_state_snapshots
indexCalls(last + 1, head)         # the real work
promoteToConfirmed(head)           # flip confirmed=TRUE on rows past head − CONFIRMATIONS
updateCursor(head, headHash)
bumpAggregatesMarker(head)
```

Pool snapshot runs **before** call ingest. If a `Trade` row references a pool that was created earlier in the same batch, `resolvePoolId` would return null and the trade would be dropped — but the snapshot upserts every pool currently on-chain, so the row exists by the time `indexCalls` runs.

### `indexCalls(hMin, hMax)`

```
resp = GET /contract?id=<DEX_CID>&state=0&hMin=hMin&hMax=hMax&nMaxTxs=2000
calls = parseCallsHistory(resp)

# Auto-split if the explorer cap was hit on a multi-block window:
if calls.length >= 2000 and hMax > hMin:
  mid = (hMin + hMax) / 2
  indexCalls(hMin, mid); indexCalls(mid + 1, hMax)
  return

tsMap = getBlockTsMap(unique_heights)   # resolves all block timestamps in one pass (cached)
for call in calls:
  blockTs = tsMap[call.height]
  writeCall(call, blockTs)              # branches on call.method
```

`writeCall` branches on method:

| Method | Effect |
|---|---|
| `Pool Create` | Updates `pools.created_at_height` to `LEAST(existing, height)` for the matching `(aid1, aid2, kind)`. The actual `aid_ctl` comes from `snapshotPoolStates`, not from the call args. |
| `Pool Destroy` | Sets `pools.destroyed_at_height = height`. |
| `Trade` | Inserts a `trades` row. Pre-computes `volume_aid1`, `volume_aid2`, `price_native` (aid2-per-aid1 in canonical ordering) at insert time so continuous aggregates don't need joins. |
| `Liquidity Add` / `Withdraw` | Inserts an `lp_events` row, kind `'Deposit'` or `'Withdraw'`, with `amount1`, `amount2`, `amount_ctl` as positive magnitudes. |

All inserts are `ON CONFLICT … DO NOTHING` against the natural-key unique indexes added in migration `014_dedupe_and_unique.sql`. Re-ingesting an already-indexed range is a no-op.

#### Trade direction (buy vs sell)

Computed at *query* time, not stored:

* The Funds row's positive entry is the asset the user paid in (`aid_in`).
* The negative entry is the asset the user received out (`aid_out`).
* `side = "buy"` when `aid_in == pools.aid1` (user bought target with base); `"sell"` otherwise. With our canonical ordering `aid1 < aid2`, this maps cleanly to CoinGecko's buy/sell convention.

### `promoteToConfirmed(head)`

```
UPDATE trades    SET confirmed = TRUE WHERE confirmed = FALSE AND height <= head - 80
UPDATE lp_events SET confirmed = TRUE WHERE confirmed = FALSE AND height <= head - 80
```

A partial index on `height WHERE confirmed = FALSE` makes both updates O(promoted-rows).

## Pool snapshots

`snapshotPoolStates(headHeight, headTs)`:

1. `GET /contract?id=<DEX_CID>&state=1` (no calls, just state).
2. Parse `State.Pools` into `PoolStateRow[]`.
3. For each row: `upsertPool(aid1, aid2, kind, aid_ctl, createdAtHeight)` ensures the `pools` row exists, then inserts (or upserts on `(pool_id, ts)`) into `pool_state_snapshots`.

This is how `pools` rows actually get created. `Pool Create` calls only update `created_at_height` — the LP token AID isn't in the call arguments, so we discover it from the pool's state row.

Snapshots cadence = once per tick. Raw rows are retained 30 days; older data lives in `liquidity_1h` (continuous aggregate, also kept indefinitely).

## Oracle snapshots

`indexOracle(headHeight)`:

```
resp = GET /contract?id=<ORACLE_CID>&state=1&nMaxTxs=0
snap = extractOracleSnapshot(resp)   # throws OracleMedianUnavailable if no median yet
INSERT INTO oracle_snapshots (ts, height, beam_usd, h_end)
VALUES (now(), headHeight, snap.beam_usd, snap.h_end)
ON CONFLICT (ts) DO UPDATE SET …
```

UI fetches the latest row for "current BEAM/USD". CG `/cg/tickers` computes `liquidity_in_usd` against the most recent snapshot. The full USD-valuation routing — including assets that aren't directly BEAM-quoted — happens in `backend/src/api/repos/usd.ts:loadUsdTable` (see [api.md §USD valuation](api.md#usd-valuation)).

## Reorg handling

`backend/src/services/reorg.ts`. BEAM reorgs in practice are 1–2 blocks deep, but the indexer is correct for arbitrary depth.

1. **Detect**: read `cursor.last_indexed_hash`; fetch `/block?height=last_indexed_height` from the chain; compare hashes. If they match, return.
2. **Find common ancestor**: walk backward with exponentially growing steps (`step *= 2` each iteration) until `/block?height=H` returns `found: true`. The explorer always serves the *active* chain's hash at H, so the first height we can fetch is on the active chain — we accept that as the ancestor.
3. **Rewind** in a single transaction:
   * `DELETE` past-ancestor rows from `trades`, `lp_events`, `pool_state_snapshots`, `block_timestamps`.
   * `UPDATE pools SET destroyed_at_height = NULL WHERE destroyed_at_height > ancestor` (undo any over-eager destruction).
   * Reset `cursor` to `(ancestor, new_hash_at_ancestor)`.
4. Continuous aggregates auto-correct on their next refresh — Timescale re-scans within `start_offset` (smallest is 6 h for `candles_1m`) on every scheduled refresh, so deleted-trade buckets recompute. Our 80-block confirmation window (~80 min) sits well inside every `start_offset`, so reorg-induced rewrites always land inside the refresh range.

Verified manually 2026-05-17: deleting a trade then calling `refresh_continuous_aggregate(...)` removed the affected candle bucket.

## Block timestamp cache

`backend/src/services/blockTimestamps.ts` keeps an LRU + Postgres-backed cache (`block_timestamps` table) of height → timestamp. The first time a trade at height H is ingested, `getBlockTs(H)` hits `/block?height=H`; subsequent reads hit memory (10 000-entry LRU) or the DB.

`getBlockTsMap(heights)` bulk-resolves the unique set, batching explorer fetches at concurrency 4 to avoid hammering the node.

## Asset discovery & metadata

* **Catalog sync** (`syncAssetsCatalog`) — every 10 minutes, fetch `/assets`, upsert each row's metadata into the `assets` table. Metadata is a `STD:SCH_VER=…;N=…;SN=…;UN=…;OPT_SHORT_DESC=…` blob parsed by `parseAssetMetadata` into our four text columns.
* **Lazy insert** (`ensureAssetExists`) — when the indexer encounters an AID inside a Trade/LP call that isn't yet in `assets` (e.g. a freshly-created LP token between catalog syncs), it inserts a stub row; the next catalog sync fills the metadata.
* **Minter integration** (`syncMinterTokens`) — when `ASSET_MINTER_CID` is set, the indexer reads the minter contract's `State.Tokens` table and upserts each token's `Limit` into `assets.max_supply` (with the UINT64_MAX sentinel mapped to NULL). Also stamps `assets.minter_cid` so the UI can flag minter-issued assets.
* **BEAM supply** (`syncBeamSupply`) — BEAM (aid 0) is not in the `/assets` registry. We read the extended `/status?exp_am=1` table for `Current Circulation` (→ `emission`) and `Total Circulation` (→ `max_supply`), parsing the comma-formatted decimal strings into groths via integer math (never float). This is what makes the BEAM asset page show the same numbers as the official BEAM explorer.

## Imposter detection

`backend/src/imposters.ts` carries a static list of `(fake_aid, real_aid, symbol_hint)` tuples — ported from dex-app's `imposterAssets.ts`. On every catalog sync (and at API startup), `seedImposters()`:

1. Sets `is_imposter = TRUE` and writes a human-readable `imposter_reason` (e.g. `"Fake USDT — real is aid 31"`) for every listed AID.
2. Clears the flag for any AID that was previously imposter but is no longer on the list — so removing an entry from the file un-flags it automatically on next startup.

`/api/pairs` and `/api/asset/{aid}` carry `is_imposter`; `/cg/*` excludes imposter pools entirely.

## Idempotency guarantees

Two safety nets keep re-ingestion from corrupting the DB:

1. **Natural-key unique indexes** on `trades` and `lp_events` (migration 014). All inserts are `ON CONFLICT DO NOTHING`. A re-run of an already-indexed height window is a no-op.
2. **Single-writer indexer** — only one tick at a time, no concurrent writes. Reorg recovery happens before any new writes are attempted.

Limitation acknowledged in migration 014: the explorer's `Calls history` response doesn't expose a kernel/tx hash (the `Keys` column is empty on observed builds). Two legitimately-identical trades in the same block (same pool, same direction, same amounts, same timestamp) would collapse to one row under the natural key. For AMM trades this is vanishingly rare — slippage tolerances make exact-match duplicates almost impossible — and the alternative (keeping known duplicates) corrupted every downstream aggregate.

## Background caches

### `dex_stats.total_volume_usd`

A single-row cache (`dex_stats` table) for the all-time cumulative trade volume in USD. The underlying query (`backend/src/services/dexStats.ts:TOTAL_VOLUME_SQL`) buckets every trade hourly, joins each bucket to the nearest oracle snapshot and the deepest BEAM-quoted pool of each side, and sums the USD-valued volume. On production-size data this exceeded Cloudflare Tunnel's ~100 s edge timeout, so the indexer recomputes it every 5 minutes in the background and `/api/stats` reads the cached value.

The refresh is `maybeKickDexStatsRefresh()` — fire-and-forget with an in-flight flag so a slow refresh can't pile up.

## Observability

* **Structured logs** via pino. Every tick logs a `tick done` line with `{from, to, trades, lp, lifecycle, skipped, promoted}`.
* **`/api/health`** returns the lag in seconds between `now()` and `cursor.updated_at`. 503 if the cursor row is missing.
* **Indexer is opinionated about failure**: an unknown DEX deploy height (no env, no /contracts entry) hard-fails on startup rather than silently truncating history.

## Pinned constants (mainnet)

| Constant | Value | Source |
|---|---|---|
| DEX_CID | `729fe098d9fd2b57705db1a05a74103dd4b891f535aef2ae69b47bcfdeef9cbf` | Pinned in `backend/.env.example`, verified live 2026-05-16. |
| DEX_DEPLOY_HEIGHT | `2270704` | Pinned in `backend/.env.example`. |
| ORACLE_CID | `4f160f01dcc6751e61d793279b803328d5332125fe8492e93ee8f3bfe9abe13b` | Pinned. State.Median ships as a pre-decoded decimal string. |
| ASSET_MINTER_CID | `295fe749dc12c55213d1bd16ced174dc8780c020f59cb17749e900bb0c15d868` | Optional, enables max-supply enrichment. |
| CONFIRMATIONS | 80 | BEAM Exchange Integration guide. |
| BEAM block time | ~60 s | Mainnet protocol param. |
| BEAM decimals | 8 (groths) | Universal across all BEAM-native assets. |
