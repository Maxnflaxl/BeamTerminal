# BeamTerminal

BeamTerminal is a self-hosted DEX terminal for the [BEAM](https://beam.mw) AMM contract. It indexes every trade, liquidity event, pool reserve change, and oracle update straight from a BEAM full node and serves three surfaces from a single backend:

* a UI-facing REST API (`/api/*`) that powers the React frontend,
* a CoinGecko-compliant public endpoint set (`/cg/*`) so the data is machine-readable for aggregators,
* the frontend itself, distributed both as a web app and as a BEAM Wallet `.dapp` bundle.

The product is the v2 of [BeamAssets.com](https://beamassets.com) / [BeamScreener](https://github.com/vsnation/BeamScreener), reimplemented end-to-end so we own the indexer, the database, and the API.

## How to read these docs

| Doc | What it covers |
|---|---|
| [architecture.md](architecture.md) | Process layout, data flow, what talks to what. The map you read first. |
| [indexer.md](indexer.md) | The polling loop: explorer parsing, pool snapshots, oracle, reorgs, confirmations. |
| [database.md](database.md) | Postgres + TimescaleDB schema. Tables, hypertables, continuous aggregates, indexes. |
| [api.md](api.md) | `/api/*` REST endpoints the UI consumes. Shapes, caching, freshness model. |
| [CoinGecko.md](CoinGecko.md) | `/cg/*` public endpoints for CoinGecko ingestion. |
| [frontend.md](frontend.md) | React app: pages, charts, swap panel, `.dapp` packaging. |
| [deployment.md](deployment.md) | VPS layout, docker-compose, explorer-node, TLS, runbook. |

## Repo layout

```
BeamTerminal/
├── backend/        Node + TypeScript: indexer, REST API, migrations
│   ├── src/
│   │   ├── indexer.ts              the long-running poll loop
│   │   ├── api.ts                  the Fastify entrypoint
│   │   ├── api/                    routes + repos + error handling
│   │   ├── parsers/                explorer payload → typed records
│   │   ├── services/               business logic (pools, oracle, reorg, …)
│   │   ├── explorer.ts             typed HTTP client for explorer-node
│   │   ├── imposters.ts            hardcoded scam-asset registry
│   │   └── config.ts               zod-validated env
│   └── migrations/                 *.sql, applied in lexical order
├── frontend/       React 17 + Linaria + lightweight-charts
│   ├── src/app/
│   │   ├── containers/Screener/    PairsList, PairDetail, AssetsList, AssetDetail
│   │   ├── core/                   BeamDappConnector, shader registry, wallet
│   │   └── shared/                 components, hooks, store (inherited)
│   └── scripts/build-dapp.sh       packages the .dapp bundle
└── docs/           this directory
```

## Tech in one breath

* **Backend** — Node.js 22, TypeScript (strict), [Fastify](https://fastify.dev), [pg](https://node-postgres.com), [undici](https://undici.nodejs.org), [pino](https://getpino.io), [zod](https://zod.dev).
* **Database** — PostgreSQL 16 + [TimescaleDB](https://www.timescale.com), continuous aggregates for OHLCV.
* **Frontend** — React 17, [Linaria](https://linaria.dev), [lightweight-charts](https://tradingview.github.io/lightweight-charts/), [react-router](https://reactrouter.com) v6, plain fetch + React hooks.
* **Wallet bridge** — `BeamDappConnector` from dex-app (verbatim), shaders loaded via `shaderRegistry.ts`.
* **Chain layer** — a single BEAM `explorer-node` binary that embeds a full node and serves an HTTP API; we poll it.

## Locked-in choices

Decisions worth remembering, with the *why* attached. Numbers are arbitrary; order is roughly the order they were made during planning.

| # | Decision | Why it stuck |
|---|---|---|
| 1 | Own indexer + DB + API; replace `buybeam.my` entirely | Full control over uptime, schema evolution, and CG submission. |
| 2 | One repo, two top-level folders (`backend/`, `frontend/`) | Easy cross-references, no monorepo tooling overhead. |
| 3 | Backend stack: **Node.js + TypeScript** | Shares types and ergonomics with the frontend; first-class fetch/streaming/JSON. |
| 4 | Indexer source: **poll a local `explorer-node`** | Explorer ships a `parser.wasm` that pretty-prints every contract — no raw-byte decoding. |
| 5 | DB: **PostgreSQL + TimescaleDB** | Continuous aggregates auto-build OHLCV across six timeframes from one `trades` hypertable. |
| 6 | Single binary, no separate `beam-node` | `explorer-node` embeds a full node *and* serves HTTP. One process, one chain DB. |
| 7 | Hosting: **single VPS**, docker-compose + systemd | Cheapest, simplest, sufficient at BEAM's trading volume. |
| 8 | Backfill from **DEX deploy height** | Full history forever; one slow first sync is acceptable. The deploy height is pinned in `.env`. |
| 9 | Pair identity = `(aid1, aid2, kind)` — one tuple per pool | AMM has three fee tiers; treating them separately preserves real price/liquidity per pool. |
| 10 | Finality: **80 blocks** before a trade is "confirmed" | Matches BEAM's [Exchange Integration Guide](https://github.com/BeamMW/beam/wiki/Exchange-integration). Public CG endpoints serve confirmed-only. |
| 11 | BEAM/USD reference: **on-chain `oracle2`** | Self-contained, no external API dep. The parser shader pre-decodes `Median` to a decimal string. |
| 12 | Public API: **open, rate-limited per IP** | Trust + monitor. Limit is 600 req/min by default; tune via `RATE_LIMIT_PER_MIN`. |
| 13 | Imposter assets: **hardcoded list in `backend/src/imposters.ts`** | Mirrors dex-app's `imposterAssets.ts`; `/cg/*` excludes them, `/api/*` flags them. |
| 14 | Swap routing: **direct to `DEX_CID`**, no fee wrapper | BeamScreener routes through vsnation's `WRAPPER_CID` for a fee skim; we don't. Users pay only the AMM's tiered fee. |
| 15 | CG asset namespace: **bare decimal AID strings** for `base_currency` / `target_currency`; **LP token AID** for `pool_id` | One LP token per pool — natural per-pool identifier with no prefix gymnastics. |

## What's not in v1

* Multi-DEX aggregation (only the AMM contract).
* Derivative or NFT data surfaces (out of scope for a spot DEX).
* Push notifications, price alerts, watchlists, user accounts.
* Public WebSocket (the wallet's `ev_system_state` covers live in-app updates; web users get fresh-on-poll).
* Server-side swap routing or quote caching — quotes come from the AMM shader directly, in the wallet.

---

For an end-to-end "how does a trade get from chain to chart?" walkthrough, start with [architecture.md](architecture.md) and follow the data flow into [indexer.md](indexer.md) → [database.md](database.md) → [api.md](api.md).
