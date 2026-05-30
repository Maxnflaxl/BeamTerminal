# Deployment

How to deploy BEAM Terminal end to end: the indexer + API backend, the static frontend, and the external BEAM `explorer-node` they read from. Everything runs on a single Linux host, behind a CDN/reverse proxy that terminates TLS.

> Hostnames, IP addresses and on-disk paths below are **examples** — substitute your own. The specifics of any particular production deployment are intentionally kept out of this doc.

## Components

- **`explorer-node`** — a BEAM full node + HTTP explorer API (`:8888`). External dependency: pin a known-good binary, never build from source.
- **Postgres + TimescaleDB**, the **indexer**, and the **api** — run together under docker-compose.
- **frontend** — a static bundle (`frontend/html/`) served straight from disk.
- **reverse proxy** (nginx) behind a **CDN** (e.g. Cloudflare) that handles public TLS.

## Host layout

```
/srv/beamterminal/              # this repo, cloned in place (example path)
├── backend/
│   ├── dist/                   # tsc output
│   ├── node_modules/
│   ├── migrations/
│   └── .env
├── frontend/
│   ├── html/                   # webpack output, served by nginx
│   └── node_modules/
├── docs/
├── nginx.conf                  # symlinked into /etc/nginx/sites-enabled/
└── docker-compose.yml          # postgres + indexer + api

/opt/beam/                      # external dependency, managed separately
├── explorer-node               # binary, from a BeamMW CI run / release
├── parser.wasm                 # monolithic explorer parser
└── explorer-data/              # chain DB the explorer-node maintains itself
```

The explorer-node lives outside the repo because its lifecycle (binary updates, chain DB) is independent of our code.

## `explorer-node` — single binary, no build-from-source

`explorer-node` ships in the official BEAM downloads alongside `beam-node` and the wallet binaries. Grab it from a recent **BeamMW/beam GitHub Actions run** or a tagged release; place it at `/opt/beam/explorer-node`.

```sh
# Ubuntu 22.04, one-time
sudo useradd -r -s /usr/sbin/nologin beam
sudo mkdir -p /opt/beam/explorer-data
sudo chown -R beam:beam /opt/beam

# Drop the Linux mainnet artifact in place
sudo -u beam install -m 755 /tmp/explorer-node /opt/beam/explorer-node

# Stage the monolithic parser.wasm. Source: bvm/Shaders/Explorer/Parser.wasm
# from a BEAM tree *before* commit 2ab98963 ("feat: explorer modules", 2026-05-03) —
# that commit deleted the monolith and replaced it with per-shader modules under
# --contract_rich_parser_folder. Either pull it out of git history of the BEAM tree
# or copy it from whichever CI run / release matches the explorer-node binary.
sudo -u beam cp /path/to/Parser.wasm /opt/beam/parser.wasm
```

`/etc/systemd/system/explorer-node.service`:

```
[Unit]
Description=BEAM explorer-node (mainnet)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=beam
WorkingDirectory=/opt/beam/explorer-data
ExecStart=/opt/beam/explorer-node \
  --peer eu-node01.mainnet.beam.mw:8100,eu-node02.mainnet.beam.mw:8100,eu-node03.mainnet.beam.mw:8100 \
  --port 10000 \
  --api_port 8888 \
  --contract_rich_parser /opt/beam/parser.wasm
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

* **`--ip_whitelist`** — the HTTP API on `:8888` is public by default. The indexer only needs `http://localhost:8888` (loopback, no TLS), so if you don't intend to serve the explorer publicly, gate it with `--ip_whitelist 127.0.0.1`.
* **No separate `beam-node`** — `explorer-node` is itself a full node + HTTP API. P2P sync on `:10000`, own `explorer-node.db` in the working folder.
* **First boot timeline** — multi-hour initial sync over P2P. `journalctl -u explorer-node -f` until `/status` returns a height equal to the network tip. The indexer can be started in parallel; it sits idle until sync completes, then begins backfilling.

## docker-compose — Postgres, indexer, api

`docker-compose.yml`:

```yaml
services:
  postgres:
    image: timescale/timescaledb:latest-pg16
    restart: always
    environment:
      POSTGRES_DB: beamterminal
      POSTGRES_USER: beamterminal
      POSTGRES_PASSWORD_FILE: /run/secrets/postgres_password
    volumes:
      - postgres-data:/var/lib/postgresql/data
    secrets: [postgres_password]
    ports:
      - "127.0.0.1:5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U beamterminal -d beamterminal"]
      interval: 5s

  indexer:
    build: ./backend
    command: node dist/src/indexer.js
    restart: always
    depends_on: { postgres: { condition: service_healthy } }
    network_mode: host                # so it can hit 127.0.0.1:8888 (explorer-node)
    env_file: ./backend/.env

  api:
    build: ./backend
    command: node dist/src/api.js
    restart: always
    depends_on: { postgres: { condition: service_healthy } }
    ports:
      - "127.0.0.1:3000:3000"
    env_file: ./backend/.env

volumes:
  postgres-data:

secrets:
  postgres_password:
    file: ./secrets/postgres_password.txt
```

The same `backend/Dockerfile` produces a single image used by both the indexer and the api services — they just override the entrypoint. The Dockerfile is a three-stage build (deps → tsc → runtime) running as the `node` user.

nginx runs **on the host**, not in compose — it serves the static React bundle straight from disk and proxies `/api` and `/cg` to `127.0.0.1:3000`.

## nginx — TLS terminated at the edge

Put a CDN/reverse proxy in front to terminate TLS; the origin then only needs to listen on `:80`. The `set_real_ip_from` block restores the true client IP from the CDN's forwarded header (e.g. `CF-Connecting-IP`) so the API's per-IP rate limit keys off the real client, not the proxy.

The config is checked into the repo at `nginx.conf`. Install it via symlink:

```sh
sudo ln -sf /srv/beamterminal/nginx.conf /etc/nginx/sites-enabled/beamterminal
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

### CDN / TLS setup (Cloudflare example)

1. DNS: an `A` record for your hostname → origin IPv4, **proxied** (orange cloud).
2. SSL/TLS mode: **Full** (origin can later add a self-signed cert without reconfiguration). Flexible works too but is weaker.
3. Optional: enable **"Always Use HTTPS"** so the edge redirects bare HTTP — the origin doesn't need a redirect block.

### Firewall (ufw)

```sh
sudo ufw allow 22                  # SSH
sudo ufw allow 80/tcp              # nginx (CDN → origin)
sudo ufw allow 8888/tcp            # explorer-node HTTP API (only if exposed publicly)
sudo ufw allow 10000/tcp           # BEAM P2P
sudo ufw enable
```

No `443` rule — the CDN reaches the origin on `:80`. If you later add an origin certificate and bump SSL mode to **Full (strict)**, add `listen 443 ssl` to `nginx.conf` and open `443/tcp` as well. Optionally restrict port 80 to your CDN's published IP ranges.

## Backup

```sh
# /etc/cron.daily/beamterminal-backup
docker compose -f /srv/beamterminal/docker-compose.yml exec -T postgres \
  pg_dump -Fc -U beamterminal beamterminal > /srv/beamterminal/backups/$(date +%F).dump
find /srv/beamterminal/backups -mtime +30 -delete
```

Replicate off-host via `rsync` or `rclone` to object storage nightly. The indexer can rebuild from chain history if all backups vanish — backups are a convenience, not a hard requirement (a full re-backfill takes hours, not days).

## First-boot runbook

```sh
# 0. Clone the repo
git clone <repo-url> /srv/beamterminal
cd /srv/beamterminal

# 1. explorer-node — running and synced (see above). Sanity check:
curl http://127.0.0.1:8888/status        # should return the current head height

# 2. Backend .env — copy from example and point EXPLORER_URL at your explorer
cp backend/.env.example backend/.env
# edit: EXPLORER_URL=http://localhost:8888, NODE_ENV=production,
#       DATABASE_URL=postgres://beamterminal:<pw>@postgres:5432/beamterminal

# 3. Postgres password secret
mkdir -p secrets
openssl rand -hex 32 > secrets/postgres_password.txt

# 4. Bring up DB + services
docker compose up -d postgres
docker compose exec postgres psql -U beamterminal -d beamterminal \
  -c "CREATE EXTENSION IF NOT EXISTS timescaledb;"
docker compose run --rm api node dist/scripts/migrate.js   # applies all migrations
docker compose up -d indexer api

# 5. Frontend bundle (build-dapp.sh runs build:prod, then bundles + copies
#    beamterminal.dapp into html/ so the nav's "Download DApp" button works).
sudo apt-get install -y zip                                  # build-dapp.sh zips the .dapp
(cd frontend && bash scripts/build-dapp.sh)                 # writes frontend/html/ + html/beamterminal.dapp
sudo mkdir -p /var/www/beamterminal
sudo rsync -av --delete frontend/html/ /var/www/beamterminal/
sudo chown -R www-data:www-data /var/www/beamterminal

# 6. nginx
sudo ln -sf /srv/beamterminal/nginx.conf /etc/nginx/sites-enabled/beamterminal
sudo nginx -t && sudo systemctl reload nginx

# 7. Watch the backfill
docker compose logs -f indexer
# Should report "backfill page" lines with eta_seconds until reaching the head

# 8. Point DNS at the origin (proxied). Once /api/health.lag_seconds < 60, it's ready:
curl https://<your-domain>/api/health
```

## Updates

```sh
cd /srv/beamterminal
git pull
docker compose build api indexer
docker compose up -d api indexer

# Frontend: build-dapp.sh runs build:prod and also bundles the .dapp into html/
# so the "Download DApp" button serves it from the web root (/beamterminal.dapp).
(cd frontend && bash scripts/build-dapp.sh)

# Publish to the nginx web root (nginx serves /var/www/beamterminal, NOT frontend/html).
# --delete drops files removed from the build; chown so nginx (www-data) can read.
rsync -av --delete frontend/html/ /var/www/beamterminal/
chown -R www-data:www-data /var/www/beamterminal

# CDNs cache static assets (e.g. /index.js) — purge after publish so users don't
# keep seeing the stale bundle until the TTL expires.
```

Zero-downtime is overkill at this scale — a few seconds of API blip on deploy is fine. Migration files are idempotent (the `schema_migrations` table tracks what's applied), so re-running `migrate.js` after `git pull` is safe.

## IPFS for `.dapp` downloads

We don't run a separate IPFS daemon — the `wallet-api` container already shipping for asset-swaps and the DApp Store projection is built with `BEAM_IPFS_SUPPORT` and embeds `asio-ipfs`. Enabling it is purely a matter of CLI flags in `backend/docker/wallet-api-entrypoint.sh`:

* `--enable_ipfs`
* `--ipfs_swarm_key "$(cat /opt/beam/ipfs/swarm.key)"` — the public BEAM mainnet PSK, baked into the image from `backend/ipfs/swarm.key`.
* `--ipfs_bootstrap` for each `eu-node0X.mainnet.beam.mw:38041/p2p/…` address.

`/api/dapp/:cid` (Fastify, see `backend/src/api/routes/dapp_download.ts`) proxies `ipfs_get` over JSON-RPC and returns the bytes with a `Content-Disposition: attachment; filename=…` header. The frontend Download button is a plain `<a download href="/api/dapp/<cid>?filename=…">`, so the browser handles streaming / progress / right-click "Save as".

Smoke test once `wallet-api` is up:

```sh
curl -fsSL -o /tmp/bridge.dapp \
  "https://<your-domain>/api/dapp/QmPWrArdausWmzB44nygzK8nxjuuQGk9MBNuWyMCHacRtn?filename=BridgeApp.dapp"
file /tmp/bridge.dapp                  # expect "Zip archive data"
```

Why this path and not a standalone Kubo daemon: we tried — Kubo's bitswap can dial BEAM's bootstrap peers (PSK works) but those peers don't store dapp blocks themselves, and the private-swarm DHT has only those few peers, so content lookup dead-ends. `asio-ipfs` succeeds because it has BEAM-specific peer-discovery logic Kubo doesn't replicate.

## `.dapp` distribution

The `.dapp` bundle is built from the same frontend source:

```sh
yarn --cwd frontend build:dapp
# produces beamterminal-<commit-count>.dapp
```

The build script versions automatically off `git rev-list --count HEAD`. Upload the artifact to the BEAM Dapp Store via the team's existing submission flow. See [frontend.md §`.dapp` bundle](frontend.md#dapp-bundle-beam-wallet) for the manifest shape.

## Monitoring

* `journalctl -u explorer-node` for the chain layer.
* `docker compose logs -f api indexer` for our services.
* `https://<your-domain>/api/health` via any uptime probe (Uptime Kuma, BetterStack, etc.).
* Alerting suggestions:
  * `/api/health.lag_seconds > 300` for > 5 min → page (indexer fell behind).
  * `oracle_snapshots.ts` older than 4 h → page (oracle stalled = USD numbers go dark).
  * Postgres container down → page.
