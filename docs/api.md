# Internal API (`/api/*`)

UI-facing REST. Stateless Fastify service (`backend/src/api.ts`). Reads from Postgres only.

The public CoinGecko-compliant endpoints (`/cg/*`) are documented separately in [CoinGecko.md](CoinGecko.md).

## Conventions

* **Transport**: JSON, UTF-8, `application/json; charset=utf-8`. Only `GET` is exposed.
* **Numbers**: amounts in groths are returned as **strings** (`NUMERIC(40, 0)` doesn't fit in JS `number`). The frontend divides by `10^decimals` to display. USD numbers are JSON numbers (USD never overflows). Timestamps are unix seconds (number); heights are integers.
* **Errors**:
  ```json
  { "error": { "code": "PAIR_NOT_FOUND", "message": "no pair 0-31-1" } }
  ```
  `code` is stable; `message` is human-readable and may change.
* **Auth**: none.
* **CORS**: open (`Access-Control-Allow-Origin: *`). The in-wallet origin works the same way.
* **Rate limit**: per-IP via `@fastify/rate-limit`, `RATE_LIMIT_PER_MIN` (default 600/min). Set to 0 to disable. Excess responses are `{ "error": { "code": "RATE_LIMITED", "message": "…" } }`.
* **Cache-Control**: per-route, typically `public, max-age=15` or `30`. `/api/health` is `no-store`.
* **API base in production**: `https://beamterminal.0xmx.net/api`. The frontend hard-codes this in `frontend/src/app/containers/Screener/api/client.ts`.

## `GET /api/health`

Liveness. Returns 200 with the lag between `now()` and `cursor.updated_at`. 503 if the cursor row is missing.

```json
{
  "status": "ok",
  "last_indexed_height": 3863512,
  "lag_seconds": 14
}
```

`Cache-Control: no-store`. The indexer rate-limit applies but `/api/health` is logged at debug level only (so it doesn't drown the request log if a probe hits it every second).

## `GET /api/stats`

Header strip data: BEAM/USD, total TVL, 24h volume, lifetime volume, pair/trade counts.

```json
{
  "beam_usd": 0.02175,
  "total_tvl_usd": 124501.22,
  "volume_24h_usd": 9182.04,
  "total_volume_usd": 4521903.55,
  "total_pairs": 95,
  "total_trades": 41812,
  "last_indexed_height": 3863512,
  "block_ts": 1747400940
}
```

* `total_tvl_usd` — sums `reserve1_usd + reserve2_usd` per active pool. For pools where only one side has a USD rate (via the [USD valuation routing](database.md#usd-valuation-strategy)), the known side is doubled (AMMs hold equal value on both sides at equilibrium). Pools where neither side is priceable are skipped.
* `volume_24h_usd` — sums one priced side per pool over the 24h trade window.
* `total_volume_usd` — point-in-time-valued lifetime volume, served from the precomputed `dex_stats` cache (refreshed by the indexer every 5 minutes). `null` until the first refresh after a fresh deploy.
* `block_ts` — timestamp of the latest oracle snapshot (proxy for last-tick wall-clock time).

`Cache-Control: public, max-age=15`.

## `GET /api/pairs`

List of all pairs with 24h stats baked in.

Query params:

| Name | Type | Default | Notes |
|---|---|---|---|
| `sort_by` | `tvl_usd \| volume_24h_usd \| price_change_24h \| trades_24h \| aid2` | `tvl_usd` | |
| `order` | `asc \| desc` | `desc` | |
| `limit` | int, 1..500 | 100 | |
| `offset` | int | 0 | |
| `search` | string | — | Substring match on `short_name` or exact AID. Splits on `/` so `BEAM/USDT` narrows to both sides. |
| `kind` | `0 \| 1 \| 2` | — | Filter to one volatility tier. |
| `include_imposters` | bool | false | If true, includes pools where either side has `is_imposter = TRUE`. |
| `group` | `tier \| pair` | `tier` | `pair` collapses fee tiers into one combined row per `(aid1, aid2)`. |

### Grouped mode (`group=pair`)

The screener lists each pair once instead of once per fee tier. Reserves,
`volume_24h_*`, `trades_24h`/`buys_24h`/`sells_24h` and `tvl_usd` are **summed**
across tiers; `price_native`/`price_usd`/`price_change_24h`/`sparkline_7d` and
the identity fields (`pair_id`, `kind`, `lp_token`) come from the **reference
(deepest) tier** — the pool with the largest `reserve1`, matching the
USD-valuation convention. Each grouped row adds a `tiers[]` array (one entry per
fee tier, deepest first) carrying `{ pool_id, kind, kind_label, lp_token,
tvl_usd, volume_24h_usd, reserve1_human, reserve2_human, price_native }`. Sorting
and slicing happen app-side after the merge.

Response shape (one entry shown — see `frontend/src/app/containers/Screener/api/types.ts` for the canonical TS type):

```json
{
  "pairs": [
    {
      "pair_id": 17,
      "aid1": 0, "aid2": 31,
      "symbol1": "BEAM", "symbol2": "USDT",
      "kind": 1, "kind_label": "Medium",
      "decimals1": 8, "decimals2": 8,

      "price_native": 29.34293421,         // aid2 per 1 aid1
      "price_usd":    0.99,                // USD per 1 aid2 unit
      "rate_2_1":     0.03408871,          // 1 / price_native

      "reserve1":       "12000000000000",  // groths
      "reserve2":       "352115210340000",
      "reserve1_human": 120000.0,          // divided by 10^decimals
      "reserve2_human": 3521152.1,
      "reserve1_usd":   4092.00,
      "reserve2_usd":   3521152.10,
      "tvl_usd":        7613152.10,

      "volume_24h_groth": "94000000000",
      "volume_24h_usd":   3206.84,

      "price_change_24h": 4.91,            // percent

      "buys_24h":  18,
      "sells_24h": 22,
      "trades_24h": 40,

      "is_imposter": false,
      "lp_token": 12345,                   // pools.aid_ctl
      "created_at_height": 1234567
    }
  ],
  "total": 95,
  "last_indexed_height": 3863512
}
```

### Sort routing

`tvl_usd` and `volume_24h_usd` are computed app-side from the USD-per-AID rates (which come from the multi-hop helper, not SQL). When sorted by either, the handler pulls a default-ordered window of up to 500 rows, sorts in JS, and slices to `[offset, offset+limit]`. Other sort keys go straight to SQL.

This matters because a tiny pool with huge raw-groth reserves but only ~\$37 of USD value would otherwise rank above genuinely deep pools.

`Cache-Control: public, max-age=15`.

## `GET /api/pairs/{id}`

Single pair, same fields as a row in `/api/pairs`.

`id` is one of:

* A numeric LP-token aid (`/api/pairs/12345`) — a single tier.
* A canonical tier tuple `<aid1>_<aid2>_<kind>` (`/api/pairs/0_31_1`; legacy `-`
  separators also accepted) — a single tier, stable across DB recreations and
  suitable for bookmarkable URLs.
* A **combined-pair** tuple `<aid1>_<aid2>` (`/api/pairs/0_31`) — returns the
  grouped row across all fee tiers (summed stats + `tiers[]`, reference-tier
  price), the same shape as a `group=pair` list entry.

404 (`PAIR_NOT_FOUND`) when no matching pool exists.

The row also carries `ctl_supply` (total LP-token supply, groths) and
`snapshot_height` (the height the reserves/`ctl_supply` are from) — these power
the liquidity-position analyzer.

`Cache-Control: public, max-age=15`.

## `GET /api/lp-position/deposit`

Resolves a single *Liquidity Add* deposit so the frontend can analyse a
liquidity position (share, fees, P&L, impermanent loss — all computed
client-side from this plus `/api/pairs/{id}`). Exactly one query param:

* `height=<n>` — looked up in `lp_events` (Postgres only).
* `kernel=<64 hex>` — **the one endpoint that touches the explorer**: a single
  `/block?kernel=` call maps the kernel to its block height, then the same
  `lp_events` lookup runs. We don't index kernel ids, hence the hop.

Returns a deposit object (`lp_token`, `aid1/aid2`, symbols, decimals, `kind` +
`fee_pct`, `amount1/amount2/amount_ctl` in groths, `height`, `ts`, `confirmed`).
When a height holds several deposits, returns `{ "candidates": [ … ] }` for the
UI to disambiguate. 404 (`DEPOSIT_NOT_FOUND` / `KERNEL_NOT_FOUND`) when nothing
matches.

`Cache-Control: public, max-age=30`.

## `GET /api/lp-position/events`

Multi-operation lookup powering the liquidity-position analyzer: resolves every
add/remove liquidity op across a list of references, so a position with several
deposits and partial withdrawals can be valued. One query param:

* `refs=<…>` — up to 50 block heights and/or 64-hex kernel ids, comma/space/
  newline separated. Kernel ids are resolved to heights via the explorer (the
  only explorer touch); refs that don't resolve — or that exceed the 50 cap —
  come back in `unresolved`.

Returns `{ "pools": [ … ], "unresolved": [ … ] }`, with ops grouped **by pool**
(`lp_token`). Each pool carries its asset/fee metadata, present-time per-unit
BEAM/USD prices (`current_beam_per_aid1`, `current_usd_per_aid1`, …), and an
`events[]` list; each event has `kind` (Deposit/Withdraw), `amount1/2/ctl`,
`height`, `ts`, `confirmed`, and the **historical** BEAM/USD price of each asset
at that op's height (`beam_per_aid1`, `usd_per_aid2`, … — null when the pair has
no BEAM route). All P&L / share / partial-withdrawal accounting is computed
client-side from this plus `/api/pairs/{id}`.

`Cache-Control: public, max-age=30`.

## `GET /api/pairs/{id}/ohlcv`

Chart candles. Accepts any `id` form from `/api/pairs/{id}`. For a **combined
pair** (`<aid1>_<aid2>`) the price OHLC is taken from the reference (deepest)
tier while `volume`/`trade_count` are **summed across all tiers** over the
reference tier's bucket window. (Buckets where only a thinner tier traded — and
the reference tier did not — are not drawn.) Single-tier ids return that pool's
series unchanged.

Query params:

| Name | Type | Default | Notes |
|---|---|---|---|
| `interval` | `1m \| 5m \| 15m \| 1h \| 4h \| 1d` | `1h` | |
| `limit` | int, 1..2000 | 500 | |
| `to` | int (unix seconds) | `now` | Returns `limit` candles strictly older than `to`. Cursor for scroll-back. |
| `denom` | `native \| usd` | `native` | If `usd`, OHLC values are converted using BEAM/USD valid at each candle's bucket. Only meaningful when one side of the pair is BEAM (aid 0). |

Response:

```json
{
  "candles": [
    {
      "time": 1747400940,
      "open": 29.341, "high": 29.401, "low": 29.305, "close": 29.380,
      "volume": "9400000000",      // groths of aid1, string
      "trade_count": 7
    }
  ],
  "interval": "1h",
  "denom": "native",
  "more": { "to": 1747314540 }    // cursor for the next older page, or null when exhausted
}
```

USD conversion details:

* For a pool with `aid1 = 0 = BEAM`: native price is aid2-per-BEAM, so USD-per-aid2 = `beamUsd / native_price`. The route inverts high/low after conversion since the inversion swaps extremes.
* For `aid2 = 0`: USD-per-aid1 = `native_price * beamUsd` directly.
* For pools with no BEAM side: `denom=usd` silently falls back to native — the route can't construct a USD reference without an oracle path.
* The handler binary-searches per candle into the oracle history fetched for the candle window; for candles older than oracle history (e.g. backfilled trades pre-dating our deployment), it falls back to the most recent oracle snapshot.

`Cache-Control: public, max-age=30`.

## `GET /api/pairs/{id}/trades`

Recent trades or LP events for one pair. A **combined-pair** id
(`<aid1>_<aid2>`) interleaves rows across every fee tier; a single-tier id
returns just that pool's rows.

Query params:

| Name | Type | Default | Notes |
|---|---|---|---|
| `kind` | `Trade \| lp` | `Trade` | `lp` returns Deposit + Withdraw events. |
| `limit` | int, 1..200 | 50 | |
| `before` | int (unix seconds) | `now` | Cursor mode — "load more" pagination. |
| `offset` | int ≥ 0 | — | Numbered pagination. When present, overrides `before`. |
| `count` | bool | false | Also return `total` (pool's full row count) for "Showing X to Y of N". |
| `include_unconfirmed` | bool | true | UI shows unconfirmed with a marker; CG endpoints always exclude. |

In offset mode the response echoes `offset` and `limit`, and (when `count=true`) `total`; `before` is `null`.

Trade response:

```json
{
  "trades": [
    {
      "trade_id": 81729,
      "timestamp": 1747400940,
      "height": 3863500,
      "aid_in": 0, "aid_out": 31,
      "amount_in":  "1000000000",
      "amount_out": "29342934",
      "side": "buy",                   // computed: aid_in == aid1 → buy
      "price_native": 29.34293421,
      "price_usd": 0.99,               // when aid1 == 0 (BEAM)
      "value_usd": 9.93,               // volume_aid1 (in whole units) × BEAM/USD when aid1 == 0
      "confirmed": true,
      "confirmations": 80              // truncated to 80 once confirmed
    }
  ],
  "before": 1747400940                 // oldest timestamp in the page (next page cursor)
}
```

LP-event response (`kind=lp`):

```json
{
  "trades": [
    {
      "event_id": 1027,
      "timestamp": 1747400940,
      "height": 3863500,
      "kind": "Deposit",
      "amount1": "10000000000",
      "amount2": "352115210000",
      "amount_ctl": "1095445115",
      "liquidity_pct": 0.18,           // signed share of the pool this event added/removed (Withdraw < 0)
      "confirmed": true
    }
  ],
  "before": 1747400940
}
```

`Cache-Control: public, max-age=15`.

## `GET /api/pairs/{id}/liquidity`

Pooled-amount time series for one pool, decomposed by the source of the reserve changes. Drives the trade page's Pool History chart (two series: pooled aid1 + pooled aid2). A **combined-pair** id (`<aid1>_<aid2>`) sums the series across every fee tier per bucket (so it matches the grouped `tvl_usd` / pooled totals); a single-tier id returns that pool's series.

Query params:

| Name | Type | Default | Notes |
|---|---|---|---|
| `source` | `total \| lp \| trades` | `total` | `total` = actual pooled reserves; `lp` = cumulative net deposits; `trades` = cumulative reserve change from swaps. `total ≈ lp + trades`. |
| `interval` | `1h \| 1d` | `1d` | Bucket width. |
| `from` | int (unix seconds) | — | Trim returned buckets (cumulative series stay correct at the left edge). |
| `to` | int (unix seconds) | — | |

Response (`amount*` are groths of aid1/aid2; divide by `10^decimalsN`):

```json
{
  "series": [
    { "ts": 1700000000, "amount1": "545527910000000", "amount2": "82055439000000" }
  ],
  "decimals1": 8,
  "decimals2": 8
}
```

`Cache-Control: public, max-age=30`.

## `GET /api/assets`

Catalog of every asset known to the backend. Wholesale (no pagination) — there are ~200 assets on mainnet today; small enough to send in one shot.

```json
{
  "assets": [
    {
      "aid": 0,
      "name": "Beam", "short_name": "BEAM", "unit_name": "BEAM",
      "description": "Native BEAM asset",
      "decimals": 8,
      "is_imposter": false, "imposter_reason": null,
      "emission":  "26279999976873600",        // for aid 0: BEAM current circulation
      "first_seen_height": null,
      "minter_cid": null,
      "max_supply": "26280000000000000",       // for aid 0: BEAM total circulation
      "pool_count": 47
    }
  ]
}
```

`Cache-Control: public, max-age=30`.

## `GET /api/asset/{aid}`

Single asset metadata + every active pool it participates in.

```json
{
  "aid": 31,
  "name": "Tether USD",
  "short_name": "USDT",
  "unit_name": "USDT",
  "description": "Wrapped USDT bridged from Ethereum",
  "decimals": 8,
  "is_imposter": false,
  "emission": "1000000000000000",
  "first_seen_height": 1234567,
  "minter_cid": "295fe749…d868",       // null if not minter-issued
  "max_supply": "5000000000000000",    // null if uncapped
  "pools": [
    { "pair_id": 17, "kind": 1, "tvl_usd": 7613.10 }
  ]
}
```

The `pools.tvl_usd` field is best-effort: it requires BEAM to be one of the sides (so the USD reference is reachable in one hop). Otherwise `null`.

400 (`BAD_REQUEST`) if `aid` isn't a non-negative integer; 404 (`ASSET_NOT_FOUND`) if no row exists.

`Cache-Control: public, max-age=30`.

## `GET /api/asset/{aid}/history`

Mint / burn / create / destroy events for an asset. Pass-through over the explorer's `/asset?id=<aid>`, lightly parsed and cached.

Query params:

| Name | Type | Default | Notes |
|---|---|---|---|
| `limit` | int, 1..500 | 100 | |

Response:

```json
{
  "aid": 31,
  "history": [
    {
      "height": 3862500,
      "event": "Mint",
      "amount":       "500000000",
      "total_amount": "1000500000000",
      "extra": ""
    }
  ],
  "cached": false
}
```

* 400 if `aid == 0` (BEAM) — there's no `/asset?id=0` endpoint on the explorer; the asset detail page reads BEAM supply from `/api/asset/0` instead.
* In-process LRU cache, 5-minute TTL. Cache key includes `limit` so different page sizes don't collide.

`Cache-Control: public, max-age=300`.

## Quote endpoint — intentionally not present

The swap panel asks the AMM shader for quotes directly (`pool_trade` with `bPredictOnly=1`) via the user's wallet. We **don't** mirror that on the server because:

1. The shader has to run anyway when the wallet executes the trade.
2. A server quote would drift from on-chain reality between request and broadcast.
3. Local AMM math is trivial (constant product) for instant UI feedback before the wallet's authoritative quote arrives.

The swap panel's local estimate uses `dy = r2·dx / (r1+dx) · (1 - fee)` with the latest `reserve1` / `reserve2` from `/api/pairs/{id}`. See [frontend.md §Wallet integration](frontend.md#wallet-integration).

## USD valuation

Backed by `backend/src/api/repos/usd.ts:loadUsdTable`. For each request that needs USD figures, the route loads:

* `beam_usd` — latest `oracle_snapshots.beam_usd`.
* A `perAid: Map<aid, usdPerWholeUnit>` built by routing each non-BEAM asset through its deepest BEAM-quoted pool (highest `reserve1` BEAM groths). Assets without a BEAM-quoted path get no rate.

The same table is used everywhere — `/api/stats`, `/api/pairs`, `/api/pairs/{id}`, `/cg/tickers` — so USD numbers match across surfaces by construction.

## Freshness model

The frontend polls. There's no WebSocket in v1.

* `/api/stats` — every 60 s.
* `/api/pairs?...` — re-fetched on mount or when sort/filter changes. Not auto-polled.
* `/api/pairs/{id}` — every 30 s on the detail page.
* `/api/pairs/{id}/ohlcv` — once on mount, plus on interval/denom change and on scroll-back (uses the `more.to` cursor).
* `/api/pairs/{id}/trades` — initial load + 30 s top-of-feed refresh that splices new trades onto the head.

The `useFetcher` / `usePolling` hooks live in `frontend/src/app/containers/Screener/hooks.ts`. They keep last-known data on screen during refreshes so the UI doesn't flicker between loaded and "Loading…" every interval.

In-wallet, the same hooks run unchanged. A future v1.x can opt into per-block refresh via `BeamDappConnector.subscribe('ev_system_state', …)` and drop the 30 s timers; the API doesn't need to change.

## Response-time targets

Measured against a 4-core / 8 GB VPS with ~50 k trades indexed:

| Endpoint | p50 | p95 |
|---|---|---|
| `/api/health` | <5 ms | 20 ms |
| `/api/stats` | 20 ms | 80 ms |
| `/api/pairs` | 40 ms | 180 ms |
| `/api/pairs/{id}` | 20 ms | 100 ms |
| `/api/pairs/{id}/ohlcv` | 25 ms | 120 ms |
| `/api/pairs/{id}/trades` | 15 ms | 80 ms |
| `/api/asset/{aid}/history` (cold) | 200 ms | 1 s (cached: <10 ms) |

`/api/asset/{aid}/history` is the outlier because it round-trips to the explorer; the 5-minute LRU keeps the hit rate high in practice.

## Versioning

The endpoints documented here are mounted at `/api/*`. When we break shape, we'll add `/api/v2/*` alongside (the version segment isn't parsed today; it's a future affordance, not a current contract).
