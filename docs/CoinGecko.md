# CoinGecko Integration

Public, no-auth endpoints we expose so CoinGecko can ingest BeamTerminal's DEX data.

Spec source: CoinGecko Integration API Standards (the official internal Google doc, 2025 edition), **Section A — Spot Exchanges API**.

BeamTerminal is a spot AMM DEX, so we serve:

* **`GET /cg/tickers`** — mandatory. 24h pricing + volume for each pair.
* **`GET /cg/historical_trades/{ticker_id}`** — optional but implemented. CG uses it for trade-history verification.

We **don't** implement `/cg/orderbook/{ticker_id}` — AMMs aren't order books. We declare the depth formula on the submission form instead (constant product, per-tier fees). See [§Orderbook policy](#orderbook-policy).

Sections B (Derivatives), C (Circulating supply), and D (NFT) of the CG spec don't apply to BeamTerminal.

## General requirements

| Requirement | How we satisfy it |
|---|---|
| Publicly accessible, no-auth | `/cg/*` is mounted authless on the same Fastify service as `/api/*`. |
| Reasonable rate limits | Per-IP, 600/min by default (configurable via `RATE_LIMIT_PER_MIN`). |
| JSON format | Default. `Content-Type: application/json`. |
| User-Agent / IP allowlist | None — the API is open. If we ever sit behind Cloudflare WAF, allow `User-Agent: CoinGecko +https://coingecko.com/` and `X-Requested-With: com.coingecko`. |
| Website data matches API data | The same Postgres rows feed `/api/*` (UI) and `/cg/*`. The UI displays last_price, 24h volume in USD, etc. on `/pair/:pairId`. Match is by construction. |

## Pair identity mapping (BEAM → CG)

The CG spec is centered on EVM contract addresses. BEAM uses integer Asset IDs (AIDs). We emit the AID directly as the "address":

| CG field | BeamTerminal value |
|---|---|
| `ticker_id` | `"<aid1>_<aid2>_<kind>"`, e.g. `"0_31_1"` for BEAM/USDT Medium tier. Underscore delimiter per CG spec. |
| `base_currency` | The base asset's AID as a decimal string, e.g. `"0"` for BEAM. |
| `target_currency` | The target asset's AID as a decimal string, e.g. `"31"` for USDT. |
| `pool_id` | The pool's **LP token AID** (`pools.aid_ctl`) as a decimal string. Every pool has a unique LP token, so this is BEAM's natural per-pool identifier — analogous to a pool contract address on EVM chains. |

Numeric fields are emitted as decimal strings (no scientific notation, no trailing zeros below meaningful precision) via a single `toDecimal()` helper, so the wire format never leaks JS's number formatting quirks. BEAM assets are 8-decimal natively; CG amounts are in **whole units** (groths divided by `10^decimals`).

## Endpoint 1 — `GET /cg/tickers`

24h pricing + volume per pair. One row per non-imposter, non-destroyed pool. Sorted by `pool_id` for deterministic output.

Response: top-level JSON array.

```json
[
  {
    "ticker_id":        "0_31_1",
    "base_currency":    "0",
    "target_currency":  "31",
    "pool_id":          "12345",
    "last_price":       "29.34293421",
    "base_volume":      "12000.5",
    "target_volume":    "351923.403287",
    "liquidity_in_usd": "7613.10",
    "bid":              "29.3",
    "ask":              "29.38",
    "high":             "29.84",
    "low":              "28.91"
  }
]
```

### Per-field semantics

| Field | Source | Notes |
|---|---|---|
| `ticker_id` | `pools.aid1 + "_" + aid2 + "_" + kind` | Stable per pool. |
| `base_currency` | `pools.aid1` as decimal string. | |
| `target_currency` | `pools.aid2` as decimal string. | |
| `pool_id` | `pools.aid_ctl` (LP token AID) as decimal string. | One LP token per pool; unique and stable. |
| `last_price` | Most recent confirmed `trades.price_native` (aid2 per aid1). | Falls back to `reserve2 / reserve1` if no trade has happened on this pool. |
| `base_volume` | Sum of `trades.volume_aid1` over the last 24h, in whole `aid1` units. Confirmed trades only. | |
| `target_volume` | Same for `aid2`. | |
| `liquidity_in_usd` | `reserve1_usd + reserve2_usd` at the latest snapshot, where each side's USD value comes from the BEAM-routed valuation table. | When neither side is BEAM, we still get USD per side as long as both AIDs are reachable through *some* BEAM-quoted pool. |
| `bid` | AMM swap-out price for buying 1 whole unit of base via the curve, post-fee: `dy = r2·1/(r1+1) · (1 − fee)`. | Required by CG for depth math. |
| `ask` | Same but reverse direction: `dx = r2/(r1−1) / (1 − fee)`. | |
| `high` / `low` | `MAX(price_native)` / `MIN(price_native)` over the last 24h of confirmed trades. Falls back to `last_price` if no trades in window. | |

### Pools we omit

* `pools.destroyed_at_height IS NOT NULL` — destroyed pools.
* Either side `assets.is_imposter = TRUE` — imposter pools.
* Zero liquidity AND zero 24h volume — keeps the catalog tight per CG's "no dead markets" guidance.

The first two filters live in SQL; the third is applied at row-build time. Imposter pools remain visible (with a warning badge) in `/api/*` but are completely hidden from `/cg/*`.

`Cache-Control: public, max-age=30`.

## Endpoint 2 — `GET /cg/historical_trades/{ticker_id}`

Trade history for a single pair, split by side per the CG spec.

`ticker_id` format: `"<aid1>_<aid2>_<kind>"`. 400 (`BAD_TICKER_ID`) on bad shape; 404 (`PAIR_NOT_FOUND`) when no active non-imposter pool matches.

Query params:

| Name | Type | Default | Notes |
|---|---|---|---|
| `type` | `"buy"` \| `"sell"` | — | If omitted, returns both. |
| `limit` | int, 0..500 | 100 | `0` means "full history" (capped at 5000 for safety). |
| `start_time` | unix seconds | — | Inclusive. |
| `end_time` | unix seconds | — | Inclusive. |

Response:

```json
{
  "buy": [
    {
      "trade_id":        81729,
      "price":           "29.34293421",
      "base_volume":     "10",
      "target_volume":   "293.4293421",
      "trade_timestamp": 1747400940000,
      "type":            "buy"
    }
  ],
  "sell": [
    {
      "trade_id":        81728,
      "price":           "29.33102233",
      "base_volume":     "5",
      "target_volume":   "146.65511165",
      "trade_timestamp": 1747400600000,
      "type":            "sell"
    }
  ]
}
```

### Per-field semantics

| Field | Notes |
|---|---|
| `trade_id` | `trades.trade_id`. Integer, unique within our DB. CG spec is explicit that `trade_id` must not be a unix timestamp; an integer is fine. |
| `price` | `trades.price_native` (aid2 per aid1), decimal string. |
| `base_volume` | `volume_aid1` in whole units (`/ 10^decimals1`), decimal string. |
| `target_volume` | `volume_aid2` in whole units, decimal string. |
| `trade_timestamp` | Unix **milliseconds** (per CG spec — note our internal API uses seconds). |
| `type` | `"buy"` if `aid_in == pools.aid1` (user spent the base to receive the target), `"sell"` otherwise. |

Filters:

* `confirmed = TRUE` only.
* Imposter / destroyed pairs respond 404 rather than empty.
* Default ordering: `trade_timestamp DESC`.

`Cache-Control: public, max-age=15`.

## Orderbook policy

AMM ≠ orderbook. Per CG spec:

> If the formula is not provided, we will apply the Uniswap V2 formula to derive depth.

BEAM AMM is a vanilla constant-product market maker (`x · y = k`), identical math to Uniswap V2. We declare on the CG submission form:

> Depth formula: constant product (Uniswap V2). Per-tier fees added to the input side: 0.05% (Low), 0.30% (Medium), 1.00% (High).

CG's default Uniswap-V2 depth derivation works as-is. If CG ever asks for an explicit endpoint we'd add it as `/cg/orderbook/{ticker_id}` synthesizing levels by walking the curve in fixed price steps — but until then it's deliberately absent.

## What CG verifies on submission

Per the spec:

> In order for us to verify the data returned in your provided API endpoints, it is mandatory to display important information (e.g. last price, 24h volume (in USD), open interest, funding rate, etc.) on your trading page/web interface. Your request will be rejected if the data in your API endpoints does not match with what is shown on your website.

Source of truth for verification is `/pair/:pairId` in the React app:

| `/cg/tickers` field | Visible on `/pair/:pairId` as |
|---|---|
| `last_price` | The "Price" value in the sidebar. |
| `base_volume` / `target_volume` | Volume row in sidebar (USD equivalent shown alongside). |
| `liquidity_in_usd` | Liquidity row in sidebar; per-side breakdown in "Pooled Tokens". |
| `bid` / `ask` | Implicit in the swap panel quote (uses the same AMM curve math). |
| `high` / `low` | Chart's 24h range (visible via crosshair OHLC legend or the chart's price-scale extremes). |

## Submission checklist

When applying via the CG application form:

* [ ] `/cg/tickers` deployed, returns ≥1 ticker.
* [ ] `/cg/historical_trades/{ticker_id}` deployed, returns recent trades for that ticker.
* [ ] Depth formula declared in the submission form: constant product, per-tier fees `0.05% / 0.30% / 1.00%`.
* [ ] Numeric fields shown in `/pair/:pairId` UI match endpoint data.
* [ ] Endpoints reachable over HTTPS, no auth, no Cloudflare bot challenge.
* [ ] Submission note explicitly states: `base_currency` / `target_currency` are BEAM Asset IDs (decimal); `pool_id` is the LP token's AID.

## Implementation notes

* `/cg/*` handlers live in the same Fastify service as `/api/*` (`backend/src/api/routes/cg/`).
* Imposter / destroyed / zero-liquidity filters are applied in the CG handlers, not via a shared SQL view — keeps the differences visible. We accept that the two surfaces have intentionally different row sets.
* Numeric formatting goes through a `toDecimal(value, maxFractionDigits)` helper so we never accidentally emit scientific notation.
* `trades.price_native` and `trades.volume_aid1` / `volume_aid2` are pre-computed at insert time (see [database.md §trades](database.md#trades--hypertable)), so the CG endpoints don't need joins against `pools` on the hot path.

## Reference implementations cited by the spec

Useful for cross-checking shape — both DEX examples:

* `https://api.hyperliquid.xyz/aggregator/v1/spot/tickers`
* `https://api.cellana.finance/api/v1/tool/tickers`

Our shape mirrors these, with the BEAM-specific AID namespace.
