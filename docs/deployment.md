# Deployment

Single VPS. Linux x86_64. ~4 cores, 8 GB RAM, 100 GB SSD is comfortably oversized for current load. Cloudflare sits in front and terminates TLS — the origin only ever speaks HTTP.

Public hostname: **`beamterminal.0xmx.net`** (proxied through Cloudflare).

## Host layout

```
/root/Beam/BeamTerminal/        # this repo, cloned in place
├── backend/
│   ├── dist/                   # tsc output
│   ├── node_modules/
│   ├── migrations/
│   └── .env
├── frontend/
│   ├── html/                   # webpack output, served by nginx
│   └── node_modules/
├── docs/                       # not shipped; gitignored, kept local
├── nginx.conf                  # symlinked into /etc/nginx/sites-enabled/
└── docker-compose.yml          # postgres + indexer + api

/opt/beam/                      # external dependency, managed separately
├── explorer-node               # binary, pulled per-deploy from a BeamMW CI run
├── parser.wasm                 # monolithic explorer parser
└── explorer-data/              # chain DB the explorer-node maintains itself
```

The explorer-node lives outside the repo because its lifecycle (binary updates, chain DB) is independent of our code.

## Development quick start

`backend/docker-compose.dev.yml` brings up a TimescaleDB instance bound to **host port 5433** (so it doesn't collide with a system Postgres on 5432). For a dev-only loop:

```sh
cd backend
cp .env.example .env                                       # default dev settings — uses public explorer
docker compose -f docker-compose.dev.yml up -d              # local TimescaleDB on :5433
yarn install
yarn migrate                                                # applies migrations/*.sql
yarn dev                                                    # tsx watch src/indexer.ts (instant reload)
yarn dev:api                                                # in another terminal
```

The default `.env.example` points `EXPLORER_URL` at `https://explorer.0xmx.net/api` — you don't need to run a local `explorer-node` for development.

## `explorer-node` — single binary, no build-from-source

`explorer-node` is shipped in the official BEAM downloads alongside `beam-node` and the wallet binaries. Grab it from a recent **BeamMW/beam GitHub Actions run** or a tagged release; place at `/opt/beam/explorer-node`.

> On this VPS the explorer-node is already installed and fully synced — the steps below are for reference / disaster recovery.

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

* **No `--ip_whitelist`** — the HTTP API on `:8888` is public, matching `explorer.0xmx.net`. The indexer hits `http://localhost:8888` (loopback, no TLS). If you want to gate it, add `--ip_whitelist 127.0.0.1`.
* **No separate `beam-node`** — `explorer-node` is itself a full node + HTTP API. P2P sync on `:10000`, own `explorer-node.db` in the working folder.
* **First boot timeline** — multi-hour initial sync over P2P. `journalctl -u explorer-node -f` until `/status` returns a height equal to the network tip. The indexer can be started in parallel; it will sit idle until sync completes, then begin backfilling.

## docker-compose — Postgres, indexer, api

`/root/Beam/BeamTerminal/docker-compose.yml`:

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

## nginx — Cloudflare in front, HTTP only on origin

Cloudflare terminates TLS; the origin only listens on `:80`. The `set_real_ip_from` block restores the true client IP from the `CF-Connecting-IP` header so the API's per-IP rate limit works correctly.

The config is checked into the repo at `nginx.conf`. Install it on the VPS via symlink:

```sh
sudo ln -sf /root/Beam/BeamTerminal/nginx.conf /etc/nginx/sites-enabled/beamterminal
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

### Cloudflare setup

1. DNS: `A beamterminal.0xmx.net → <VPS IPv4>`, **proxied** (orange cloud).
2. SSL/TLS mode: **Full** (origin can later add a self-signed cert without reconfiguration). Flexible works too but is weaker.
3. Optional: enable **"Always Use HTTPS"** so Cloudflare redirects bare HTTP at the edge — the origin doesn't need a redirect block.

### Firewall (ufw)

```sh
sudo ufw allow 22                  # SSH
sudo ufw allow 80/tcp              # nginx (Cloudflare → origin)
sudo ufw allow 8888/tcp            # explorer-node HTTP API (public, matches explorer.0xmx.net)
sudo ufw allow 10000/tcp           # BEAM P2P
sudo ufw enable
```

No `443` rule — Cloudflare hits the origin on `:80`. If you later add an origin certificate (Cloudflare → "Origin Server" → "Create Certificate") and bump SSL mode to **Full (strict)**, add `listen 443 ssl` to `nginx.conf` and open `443/tcp` as well.

Optionally tighten port 80 to Cloudflare's published ranges only — see `https://www.cloudflare.com/ips/`. Skipped here for simplicity.

## Backup

```sh
# /etc/cron.daily/beamterminal-backup
docker compose -f /root/Beam/BeamTerminal/docker-compose.yml exec -T postgres \
  pg_dump -Fc -U beamterminal beamterminal > /root/Beam/BeamTerminal/backups/$(date +%F).dump
find /root/Beam/BeamTerminal/backups -mtime +30 -delete
```

Off-VPS replication via `rsync` or `rclone` to S3/B2 nightly. The indexer can rebuild from chain history if all backups vanish — backups are a convenience, not a hard requirement (the full re-backfill takes hours, not days).

## First-boot runbook

```sh
# 0. Clone the repo
sudo mkdir -p /root/Beam && cd /root/Beam
git clone <repo-url> BeamTerminal
cd BeamTerminal

# 1. explorer-node — already running on this VPS. Sanity check:
curl http://127.0.0.1:8888/status        # should return the current head height

# 2. Backend .env — copy from example and switch EXPLORER_URL to localhost
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

# 5. Frontend bundle
yarn --cwd frontend install
yarn --cwd frontend build:prod                              # writes frontend/html/
sudo mkdir -p /var/www/beamterminal
sudo rsync -av --delete frontend/html/ /var/www/beamterminal/
sudo chown -R www-data:www-data /var/www/beamterminal

# 6. nginx
sudo ln -sf /root/Beam/BeamTerminal/nginx.conf /etc/nginx/sites-enabled/beamterminal
sudo nginx -t && sudo systemctl reload nginx

# 7. Watch the backfill
docker compose logs -f indexer
# Should report "backfill page" lines with eta_seconds until reaching the head

# 8. Cloudflare DNS — point beamterminal.0xmx.net at the VPS (proxied).
#    Once /api/health.lag_seconds < 60, the site is ready:
curl https://beamterminal.0xmx.net/api/health
```

## Updates

```sh
cd /root/Beam/BeamTerminal
git pull
docker compose build api indexer
docker compose up -d api indexer

# Frontend:
yarn --cwd frontend install
yarn --cwd frontend build:prod

# Publish to nginx root (nginx serves /var/www/beamterminal, NOT frontend/html).
# --delete drops files removed from the build; chown so nginx (www-data) can read.
rsync -av --delete frontend/html/ /var/www/beamterminal/
chown -R www-data:www-data /var/www/beamterminal

# Cloudflare caches /index.js and other static assets for max-age=14400.
# After publish, purge in the CF dashboard (or via API) — otherwise users see
# the stale bundle until the TTL expires.
```

Zero-downtime is overkill at this scale — a 5 s API blip on deploy is fine. Migration files are idempotent (the `schema_migrations` table tracks what's been applied), so re-running `migrate.js` after `git pull` is safe.

## IPFS for `.dapp` downloads

We don't run a separate IPFS daemon — the `wallet-api` container already
shipping for asset-swaps and the DApp Store projection is built with
`BEAM_IPFS_SUPPORT` and embeds `asio-ipfs`. Enabling it is purely a matter
of CLI flags in `backend/docker/wallet-api-entrypoint.sh`:

* `--enable_ipfs`
* `--ipfs_swarm_key "$(cat /opt/beam/ipfs/swarm.key)"` — the public BEAM mainnet
  PSK, baked into the image from `backend/ipfs/swarm.key`.
* `--ipfs_bootstrap` for each `eu-node0X.mainnet.beam.mw:38041/p2p/…` address.

`/api/dapp/:cid` (Fastify, see `backend/src/api/routes/dapp_download.ts`)
proxies `ipfs_get` over JSON-RPC and returns the bytes with a
`Content-Disposition: attachment; filename=…` header. The frontend Download
button is a plain `<a download href="/api/dapp/<cid>?filename=…">`, so the
browser handles streaming / progress / right-click "Save as".

Smoke test once `wallet-api` is up:

```sh
curl -fsSL -o /tmp/bridge.dapp \
  "https://beamterminal.0xmx.net/api/dapp/QmPWrArdausWmzB44nygzK8nxjuuQGk9MBNuWyMCHacRtn?filename=BridgeApp.dapp"
file /tmp/bridge.dapp                  # expect "Zip archive data"
```

Why this path and not a standalone Kubo daemon: we tried — Kubo's bitswap
can dial BEAM's bootstrap peers (PSK works) but those peers don't store dapp
blocks themselves, and the private-swarm DHT has only those four peers, so
content lookup dead-ends. `asio-ipfs` succeeds because it has BEAM-specific
peer-discovery logic Kubo doesn't replicate. See memory: beam-ipfs-swarm.

## `.dapp` distribution

The `.dapp` bundle is built from the same frontend source:

```sh
yarn --cwd /root/Beam/BeamTerminal/frontend build:dapp
# produces beamterminal-<commit-count>.dapp
```

The build script versions automatically off `git rev-list --count HEAD`. Upload the artifact to the BEAM Dapp Store via the team's existing submission flow. See [frontend.md §`.dapp` bundle](frontend.md#dapp-bundle-beam-wallet) for the manifest shape.

## Monitoring

* `journalctl -u explorer-node` for the chain layer.
* `docker compose logs -f api indexer` for our services.
* `https://beamterminal.0xmx.net/api/health` via any uptime probe (Uptime Kuma, BetterStack, etc.). Cloudflare's own health checks also work.
* Alerting suggestions:
  * `/api/health.lag_seconds > 300` for > 5 min → page (indexer fell behind).
  * `oracle_snapshots.ts` older than 4 h → page (oracle stalled = USD numbers go dark).
  * Postgres container down → page.

## Failure scenarios — operational

| Event | Action |
|---|---|
| VPS dies | Restore latest `pg_dump`, point Cloudflare DNS to new VPS IP. Indexer catches up from cursor. New explorer-node has to resync the chain DB from peers (multi-hour) before the indexer makes progress. |
| Disk fills | Check TimescaleDB chunk retention; the explorer's chain DB is the bigger consumer (few GB, slowly growing). Compress old hypertable chunks if needed. |
| `explorer-node` on wrong fork | Stop the service, wipe `/opt/beam/explorer-data/`, restart. It re-syncs from peers. Rare, manual. |
| Mainnet DEX redeployed under a new CID | Update `DEX_CID` and `DEX_DEPLOY_HEIGHT` in `.env`, restart indexer. It backfills the new contract from its genesis. Old `pools` rows survive (just stop seeing new trades). |
| Indexer crashed mid-backfill | systemd / docker restarts. On startup, `catchUpAggregatesIfNeeded()` notices `aggregates_refreshed_at_height < last_indexed_height` and re-runs `refresh_continuous_aggregate(view, NULL, NULL)` for every view. No manual intervention. |
| Oracle stalled | `oracle_snapshots` stops growing; USD numbers in the UI dark out. Investigate the on-chain feeds — outside our system. |
| Cloudflare outage | The origin is still reachable directly by IP on `:80`. If you need to fail open, lower Cloudflare proxy to DNS-only (grey cloud) — but then port 80 is exposed to the world, so re-enable proxy when CF is back. |

## Sec hygiene

* `ufw` ruleset: 22, 80, 8888, 10000 (see above). No 443 — Cloudflare handles TLS.
* Postgres bound to `127.0.0.1` only.
* API bound to `127.0.0.1` only; nginx is the public-facing surface for the SPA + `/api` + `/cg`.
* `explorer-node` HTTP API is **publicly reachable** on `:8888` — same shape as `explorer.0xmx.net`. No IP whitelist. If we later want to gate it, add `--ip_whitelist` to the systemd unit.
* SSH key-only, fail2ban.
* `unattended-upgrades` for security patches. The `explorer-node` binary itself is updated manually on BEAM releases.
* Per-IP rate limit on the API (default 600/min) absorbs accidental crawler hammering; set `RATE_LIMIT_PER_MIN=0` to disable, or raise for a specific known crawler. Rate limiting is keyed off the **real client IP** restored from `CF-Connecting-IP` — if nginx ever stops being behind Cloudflare, drop the `set_real_ip_from` block in `nginx.conf` to avoid trusting spoofed headers.
