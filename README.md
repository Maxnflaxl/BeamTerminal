# BeamTerminal

A DEX terminal for [BEAM](https://beam.mw). Indexes the on-chain AMM, serves a REST API for the UI and CoinGecko-compliant public endpoints, and ships a React frontend that runs as a website and as a `.dapp` inside the BEAM wallet.

Design and decisions live in [`docs/`](docs/README.md).

## Stack

- Indexer + API: Node.js + TypeScript, polling a self-run `explorer-node` (one binary, BEAM full node + HTTP API).
- Database: PostgreSQL + TimescaleDB. Trades, LP events, pool state and oracle reads are hypertables; OHLCV across six timeframes comes from continuous aggregates.
- Frontend: React + Linaria + lightweight-charts, bundled with webpack. Same build for web and the wallet `.dapp`.
- Deployment: single VPS, docker-compose + systemd, nginx in front.

## Backend

```sh
cd backend
cp .env.example .env
docker compose -f docker-compose.dev.yml up -d
yarn install
yarn migrate
yarn dev
```

Defaults to `https://explorer.0xmx.net/api`, so you don't need a local `explorer-node` to develop. More in [`backend/README.md`](backend/README.md).

## Frontend

```sh
cd frontend
yarn install
yarn dev
yarn build:prod
```

## Docs

| Doc | Covers |
|---|---|
| [`architecture.md`](docs/architecture.md) | Process layout, data flow, failure modes |
| [`indexer.md`](docs/indexer.md) | Polling loop, parsers, reorg / finality |
| [`database.md`](docs/database.md) | Schema, hypertables, continuous aggregates |
| [`api.md`](docs/api.md) | UI-facing REST endpoints |
| [`CoinGecko.md`](docs/CoinGecko.md) | CG-compliant public endpoints |
| [`frontend.md`](docs/frontend.md) | Page-by-page UI plan, mobile breakpoints |
| [`deployment.md`](docs/deployment.md) | VPS layout, docker-compose, systemd |
