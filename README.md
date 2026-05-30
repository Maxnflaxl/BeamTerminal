# <img src="frontend/src/favicon.svg" alt="" height="28" valign="middle"> BeamTerminal

A DEX terminal and analytics explorer for [BEAM](https://beam.mw) — live trading data, price charts, liquidity analytics, asset and DApp Store browsing, and atomic-swap order books, all read straight from the chain. It runs as a website and as a dapp inside the BEAM Wallet.

## Features

- **AMM screener** — every BEAM DEX pair with live price, volume, and reserves, indexed directly from the chain. Pairs are grouped across all three fee tiers (0.05% / 0.30% / 1.00%), with per-tier detail one click away.
- **Pair charts** — candlestick price history across six timeframes, from one minute to one day, alongside a liquidity-over-time chart and fee-tier-aware trade and liquidity activity feeds.
- **Liquidity position analyzer** — follow a position across multiple add and remove operations, including partial withdrawals, with profit and loss shown in both USD and BEAM.
- **Assets** — supply and issuance for every confidential asset, the on-chain owner, logos and brand colors, and a built-in registry that flags scam tokens impersonating the real ones.
- **DApp Store** — the full publish history of every app, with verifiable publish and update dates taken from the chain, publisher profiles, social links, and one-click downloads.
- **Atomic & asset swaps** — open atomic-swap offers, plus the wallet-only asset-to-asset offers that the public explorer can't serve.
- **Public IPFS gateway** — streams DApp Store content from BEAM's private network, with active content neutralized at the edge and every app pinned automatically.
- **CoinGecko feed** — a public, spec-compliant market-data surface for listing aggregators, with imposters and destroyed pools filtered out.

**Integrating?** The [API reference](docs/api.md) and the [CoinGecko endpoints](docs/CoinGecko.md) cover everything you need to pull data.

## How it works

BeamTerminal runs its own BEAM node and watches every new block. It decodes each DEX trade, liquidity event, asset change, and oracle update, and stores them in a time-series database — so the site can serve fast charts and feeds without querying the chain on every request. A read-only wallet service, holding no funds, backs the asset-swap order books and IPFS downloads. Everything is served over a REST API behind nginx; nothing is ever written back to the chain.

---

## Architecture

Four long-lived processes on a single host, with nginx terminating TLS:

1. **Explorer node** — a pinned BEAM binary that runs a full node and exposes an HTTP explorer API. It decodes contract calls into typed data for us; we never build it ourselves.
2. **Indexer** — a Node.js + TypeScript service that polls the explorer every 30 seconds: check for reorgs, read the new head, snapshot the oracle and pool reserves, ingest contract calls, and promote them to confirmed after 80 blocks. A single process with a single writer — the invariant that keeps reorg recovery simple.
3. **API** — a read-only Fastify server over Postgres. It serves the UI-facing endpoints, the CoinGecko feed, the public IPFS gateway, and the in-wallet app-download proxy.
4. **Wallet API** — a pinned, read-only BEAM wallet daemon (no funds) that joins BEAM's private IPFS swarm. It backs the asset-swap order books, the DApp Store projection, and IPFS content retrieval.

Data lives in a single PostgreSQL + TimescaleDB instance. Trades, liquidity events, pool snapshots, and oracle reads are time-series tables; price candles and liquidity history are precomputed as continuous aggregates. All inserts are idempotent, so the indexer is safe to restart at any point.

No Redis, message queue, worker pool, or WebSocket — the API caches with HTTP cache headers only.

The frontend is React + Linaria + lightweight-charts, bundled with webpack. The same build serves the public website and the in-wallet app, so we hold the line at the wallet's QtWebEngine (Chrome 83) and avoid newer CSS.

## Development

### Backend

```sh
cd backend
cp .env.example .env
docker compose -f docker-compose.dev.yml up -d   # local TimescaleDB on :5433
yarn install
yarn migrate                                     # idempotent, lexical order
yarn dev                                         # indexer daemon
yarn dev:api                                     # Fastify API
yarn typecheck
```

Defaults to a public BEAM explorer, so no local explorer node is needed for development. To add a migration, drop a numbered SQL file into the migrations folder and re-run `yarn migrate`.

### Frontend

```sh
cd frontend
yarn install
yarn dev         # webpack-dev-server
yarn build:prod  # production bundle written to frontend/html/ (the committed one)
yarn lint
yarn prettier
```

Verify changes with `yarn build:prod` — the pinned TypeScript flags false positives on the newer syntax used in the chart files, so don't trust a raw `tsc`. The committed `html/` is the production bundle; never commit a dev build.

## Deployment

Runs under docker-compose (Postgres, indexer, API, wallet API), with the explorer node managed separately and nginx terminating TLS at the edge. Full runbook in `[docs/deployment.md](docs/deployment.md)`.

## Documentation

Design and decisions live in `[docs/](docs/README.md)`.


| Doc                                       | Covers                                      |
| ----------------------------------------- | ------------------------------------------- |
| `[architecture.md](docs/architecture.md)` | Process layout, data flow, failure modes    |
| `[indexer.md](docs/indexer.md)`           | Polling loop, parsers, reorg / finality     |
| `[database.md](docs/database.md)`         | Schema, hypertables, continuous aggregates  |
| `[api.md](docs/api.md)`                   | UI-facing endpoints                         |
| `[CoinGecko.md](docs/CoinGecko.md)`       | CoinGecko-compliant public endpoints        |
| `[frontend.md](docs/frontend.md)`         | Page-by-page UI plan, mobile, wallet bridge |
| `[deployment.md](docs/deployment.md)`     | Build, run, and update steps; IPFS swarm    |


