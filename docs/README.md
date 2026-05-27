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

---

For an end-to-end "how does a trade get from chain to chart?" walkthrough, start with [architecture.md](architecture.md) and follow the data flow into [indexer.md](indexer.md) → [database.md](database.md) → [api.md](api.md).
