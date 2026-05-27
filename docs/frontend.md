# Frontend

React 17 + TypeScript + [Linaria](https://linaria.dev) + React Router v6 + [lightweight-charts](https://tradingview.github.io/lightweight-charts/), built on top of the [dex-app](../../dex-app) foundation (BeamDappConnector, shared components, store, fonts, design tokens) without forking it as a new repo.

The terminal-specific UI lives in `frontend/src/app/containers/Screener/`. Everything outside that folder is inherited from the dex-app skeleton (the wallet bridge, the shared component library, the redux/saga store, the Linaria setup).

## How the fork was done

The Screener container is **additive** — we kept dex-app's plumbing intact and added a self-contained `Screener/` subtree that pulls data from `/api/*` instead of from on-chain shaders.

```
frontend/src/app/containers/
├── Pools/        ← inherited from dex-app; carries wallet/shader saga that the Screener relies on
└── Screener/     ← BeamTerminal UI
    ├── api/      typed REST client + response types
    ├── components/  Chart, IconsPair, KindBadge, StatsBar, SwapPanel, format helpers
    ├── containers/  PairsList, PairDetail, AssetsList, AssetDetail
    ├── hooks.ts  useStats, usePairs, usePair, useOhlcv, useTradeFeed, useAsset…
    ├── wallet.ts useWallet hook + invokeTrade wrapper
    └── index.ts  re-exports the four route entries
```

The four route components (`PairsList`, `PairDetail`, `AssetsList`, `AssetDetail`) are wired into `app.tsx`:

```ts
const routes = [
  { path: '*',                       element: <Navigate to={ROUTES.NAV.PAIRS} replace /> },
  { path: ROUTES.NAV.PAIRS,          element: <PairsList /> },
  { path: ROUTES.NAV.PAIR_DETAIL,    element: <PairDetail /> },
  { path: ROUTES.NAV.ASSETS,         element: <AssetsList /> },
  { path: ROUTES.NAV.ASSET_INFO,     element: <AssetDetail /> },
];
```

`TopNav` items: **Pairs · Assets**.

## Data layer

`Screener/api/client.ts` — a 90-line `fetch` wrapper. No middleware, no caching beyond what the browser does with `Cache-Control`. Production URL is hardcoded to `https://beamterminal.0xmx.net/api`; dev uses the webpack dev-server proxy.

`Screener/api/types.ts` — hand-written TypeScript mirrors of every backend response shape. Kept hand-written (rather than codegen'd) so we can document field semantics inline.

`Screener/hooks.ts` — every page composes from a small set of hooks:

* `useFetcher(fetcher, deps)` — generic AsyncState wrapper. Keeps last-known data on screen during refetches so the UI doesn't flicker between loaded and "Loading…".
* `usePolling(fetcher, deps, interval)` — `useFetcher` plus a `setInterval` re-runner.
* `useStats()` — `/api/stats`, 60 s poll.
* `usePairs(params)` — `/api/pairs`, default 30 s poll. Re-fetches when sort/filter changes.
* `usePair(id)` — `/api/pairs/{id}`, 30 s poll.
* `useOhlcv(id, { interval, denom })` — initial load + scroll-back pagination. Manages `cursor`, `inflight`, `hasMore` via refs so `loadOlder` doesn't recreate itself on every render.
* `useTrades(id)` / `useLpEvents(id)` — simple polled lists.
* `useTradeFeed(id, kind)` — append-only paginated feed. Splices new trades into the head every 30 s, dedupes by id, keeps any older pages the user has scrolled to.
* `useAsset(aid)`, `useAssets()`, `useAssetHistory(aid)`.

## Pages

### `PairsList` — `/pairs` (the home)

Sortable table of every active non-imposter pair, **listed once per pair** (fee
tiers combined via `/api/pairs?group=pair`). Columns: pair (icons + symbols +
AID hint), Tier (a `TiersBadge` — fee pill for one tier, colour-coded dots when
several), 24h%, Liquidity, Volume, Trades — all aggregated across tiers.

* `<Search>` box live-filters via `/api/pairs?search=…` (split on `/` so `BEAM/USDT` narrows to both sides).
* Sort headers toggle `sort_by` + `order`. With `group=pair` the sort/slice runs app-side after the tier merge (see [api.md §Grouped mode](api.md#grouped-mode-grouppair)).
* Imposter pairs hidden by default; `?include_imposters=true` exposes them.
* Click a row → `navigate('/pair/0_31')` (combined-pair form, no kind).

### `PairDetail` — `/pair/:id`

Default `id` is the combined-pair form (`aid1_aid2`), so the page opens on the
whole pair. A **tier switcher** (`Auto · Low · Medium · High`, shown only when
the pair has >1 tier) drives the data source: `Auto` charts the combined pair
(reference-tier price + summed volume) and lets the swap auto-route; picking a
tier re-fetches `aid1_aid2_kind` so the chart, trades, reserves and swap all
pin to that single pool.

Two-column grid (`1fr 320px`) that collapses to a single column at `≤960px`.

```
┌──────────────────────────────────────────┬─────────────────────────┐
│  ←  BEAM / USDT  [Medium 0.3%]           │   PRICE                 │
├──────────────────────────────────────────┤   $0.99                 │
│  [1m][5m][15m][1h][4h][1d]  USD ─ BEAM   │   29.34 USDT            │
│  Candle ─ Area                           ├─────────────────────────┤
│                                          │   24h Change   +4.91%   │
│                       chart              │   24h Volume   $3.21K   │
│                                          │   Liquidity    $7.61K   │
│                                          │   Buys / Sells 18 / 22  │
│                                          ├─────────────────────────┤
├──────────────────────────────────────────┤   Pooled Tokens         │
│  [Trades] [LP]                           │     BEAM   120 000      │
│  Time   Side   Price   Amount   Value    │     USDT 3 521 152      │
│                                          ├─────────────────────────┤
│                trade table               │   Pair Info             │
│                                          │     ID 0-31-1           │
│                                          │     LP token #12345     │
│                                          │     1 BEAM = 29.34 USDT │
│                                          ├─────────────────────────┤
│                                          │   ── Swap ──            │
│                                          │   You pay   [10]  BEAM  │
│                                          │              ↕          │
│                                          │   Receive   293.4 USDT  │
│                                          │   [   Swap   ]          │
└──────────────────────────────────────────┴─────────────────────────┘
```

Chart toolbar:

* **Timeframe** — `1m 5m 15m 1h 4h 1d`. Switching reloads via `useOhlcv`.
* **Denomination** — `USD | BEAM`. Only enabled when the pair includes BEAM (aid 0); otherwise USD silently falls back to native (see [api.md §ohlcv](api.md#get-apipairsidohlcv)).
* **Style** — `Candle | Area`. Switching tears down the lightweight-charts series and reinstalls a new one with the same data; the time scale and crosshair persist.

The chart's left-top legend mirrors TradingView: `O … H … L … C … ±change% DENOM`. Updated on `subscribeCrosshairMove` against a `candlesRef` (so the callback stays referentially stable). Scroll-back fires `loadOlder` when `range.from < 10` bars from the leftmost loaded candle.

### `AssetDetail` — `/asset/:aid`

Asset metadata + the full list of pools the asset participates in, with TVL when computable.

For aid 0 (BEAM), supply numbers come from `/api/asset/0` (which itself reads `/status?exp_am=1` totals during indexer sync) — the page matches what the official BEAM explorer shows.

### `AssetsList` — `/assets`

Wholesale table of every known asset. Imposter rows shown with a warning column. Click → `/asset/:aid`.

## Components

| Component | Purpose | Notes |
|---|---|---|
| `Chart` | Wraps lightweight-charts v4 | Single instance per pair page. Props: `candles`, `style`, `denomSymbol`, `onReachStart`. Rebuilds the chart on `style` change; pushes data on `candles` change. Fits content only on first load — later updates preserve the user's pan/zoom. |
| `IconsPair` | Overlapping-circles icon pair | The dex-app `AssetsIcon` plus a small composition layer. |
| `KindBadge` | Low/Medium/High pill | Color: Low=blue, Medium=green, High=yellow. |
| `StatsBar` | Header strip with BEAM/USD, TVL, 24h vol, total vol, pair/trade counts | Polls `/api/stats` via `useStats`. |
| `SwapPanel` | Two-input swap UI with direction flip | See [§Wallet integration](#wallet-integration). |
| `format` helpers | `fmt$`, `fmtPct`, `fmtPrice`, `fmtPriceSub`, `fmtNum`, `fmtDate`, `pairUrlId` | Centralized so the chart's price labels and the table cells render identically. |

## Wallet integration

`Screener/wallet.ts` — a thin layer on top of the dex-app `BeamDappConnector` (`@core/connector`).

```ts
export function useWallet(): WalletState & { connect: () => Promise<boolean> } {
  // Polls connector.isConnected() every 3s. Returns:
  //   headless    — true when no wallet API is reachable
  //   inWallet    — true when running inside the BEAM wallet's QtWebEngine
  //   connecting  — true while a connect() attempt is in flight
}

export async function invokeTrade(args: TradeArgs): Promise<TradeResult> {
  await ensureConnected();
  return TradePoolApi<TradeResult>(args);   // re-exports dex-app's existing AMM call
}
```

### Swap flow

`SwapPanel.tsx`. State machine for one input field, with **best-pool routing**
across fee tiers (the `tiers` prop, supplied by `PairDetail` in `Auto`). It
ports dex-app's `findBestPool`: when several tiers exist it quotes each and
keeps the highest output, executing against the winning `kind`. With a single
tier (or a tier-pinned view) it behaves as before against `pair.kind`.

1. **User types `amountIn`** — `useEffect` runs the local constant-product estimate `dy = r2·dx / (r1+dx) · (1-fee)` against **each tier's** `reserve1_human` / `reserve2_human` and keeps the best output (`localBestKind`). Gives a "You receive" preview, and picks a routing tier, even before the wallet connects.
2. **400 ms debounce** — if a wallet is reachable (`!headless`), a debounced quote fires `invokeTrade({ ..., kind, bPredictOnly: 1 })` for **every tier in parallel** (`Promise.all`); the highest `buy` wins (`confirmedQuote.kind`). We display the AMM's exact `buy` plus DAO + LP fee breakdowns and label the routed tier ("Fee tier (best)").
3. **User clicks Swap** — `invokeTrade({ ..., kind: execKind, bPredictOnly: 0 })` against the routed tier. The wallet prompts; on success we get `{ txid }` and surface a "Swap submitted" toast on the button itself.

Shader convention (from BeamScreener line 1547, kept identical so the existing shader work):

```
callAid1 = receive.aid     // the asset the user is buying
callAid2 = pay.aid         // the asset the user is paying with
val2_pay = groths the user is paying in callAid2
val1_buy = groths the user wants in callAid1 (0 = "as much as you can")
```

**No wrapper contract**. BeamScreener routes through `WRAPPER_CID = 602569ee…` (vsnation's fee skim). We call `DEX_CID` directly — users pay only the AMM's tiered fee (0.05% / 0.30% / 1.00%), BeamTerminal collects nothing in v1.

### Button state machine

The single Swap button reflects every state:

| Condition | Label | Variant | Disabled |
|---|---|---|---|
| Feedback success | "Swap submitted" | success | yes |
| Feedback error | (error text, truncated) | error | yes |
| `headless` | "Open in BEAM Wallet to swap" | muted | yes |
| `executing` | "Swapping…" | muted | yes |
| No amount | "Enter amount" | muted | yes |
| `quoting && !confirmedQuote` | "Fetching quote…" | muted | yes |
| ready | "Swap" | primary | no |

## Charts

* `lightweight-charts` v4.x (TradingView).
* Single chart instance per pair page; re-instantiated when `style` (`candle` ↔ `area`) changes.
* Pre-loaded with `limit=500` candles on mount.
* Scroll-back: on `subscribeVisibleLogicalRangeChange`, when `range.from < 10`, the chart fires `onReachStart` which triggers `useOhlcv.loadOlder()`. The hook serializes requests with an `inflight` ref so a tight scroll-event cadence can't dogpile.
* Color scheme (dex-app tokens):
  * Background — `#042548` (`--color-dark-blue`)
  * Grid — `rgba(255, 255, 255, 0.04)`
  * Up — `#00f6d2` (`--color-green`)
  * Down — `#f25f5b` (`--color-red`)
  * Crosshair — green, low opacity
* `fmtPriceSub` formatter renders very small numbers in TradingView's subscript form (`0.0₇1745`).
* Compatibility tweak: legend DOM is built with `appendChild` in a loop, not `replaceChildren` — the desktop wallet's QtWebEngine predates Chrome 86.

## State management

Despite the dex-app skeleton coming with a Redux + Redux-Saga store, the Screener tree uses **plain React hooks for its own data**. The store is still loaded (it owns wallet connection state and the dex-app shared chrome), but no Screener-specific reducers or sagas exist.

This keeps the data layer trivial — one fetch wrapper, one polling hook, four pages — at the cost of giving up cross-page caching. Re-navigating to a previously-viewed pair refetches everything. Acceptable today; revisit if pair count or visit frequency grows enough that the API becomes the bottleneck.

## Mobile

Linaria styles, one `@media` block per component. The detail page collapses to a single column at `≤960px`; tables get `overflow-x: auto` with a `min-width` so the row layout stays predictable on narrow screens. The chart resizes via `autoSize: true` (lightweight-charts handles container observers internally).

## Packaging — web + `.dapp`

Single webpack build produces `html/`. From there, two distribution targets:

### Web (beamterminal.com)

* `nginx` serves `html/` as static.
* TLS via Let's Encrypt.
* `/api/*` and `/cg/*` proxied through the same origin.

### `.dapp` bundle (BEAM Wallet)

`scripts/build-dapp.sh`:

```sh
yarn install
yarn build:prod                       # webpack → html/
cp -r html/*  beamterminal/app/
cp src/app/shared/icons/logo-dex.svg beamterminal/app/logo.svg

cat > beamterminal/manifest.json <<EOF
{
  "name": "BeamTerminal",
  "description": "Beam DEX terminal — pairs, charts, trades, swap.",
  "icon": "localapp/app/logo.svg",
  "url":  "localapp/app/index.html",
  "version": "1.0.<git rev-list --count HEAD>",
  "api_version":     "7.3",
  "min_api_version": "7.3",
  "guid": "d5669ebc08394e15a394011a8020dd9a"
}
EOF

(cd beamterminal && zip -r ../beamterminal.dapp ./*)
```

The version segment is the commit count, so every build is uniquely versioned without manual bumps. The shaders bundled into the `.dapp` are `amm.wasm` (the primary AMM) and `dao-accumulator.wasm` (used by the dex-app shared chrome for staking-style UI components). See `src/app/core/shaderRegistry.ts`.

When running inside the wallet, the React bundle still hits `https://beamterminal.0xmx.net/api` for data — the wallet's iframe doesn't sandbox network access.

## Build

```sh
yarn install
yarn dev            # webpack-dev-server, HMR
yarn build:prod     # production webpack (Linaria extracted, minified) → html/
yarn lint
yarn prettier
```

`scripts/build-dapp.sh` is the only script outside `package.json`.
