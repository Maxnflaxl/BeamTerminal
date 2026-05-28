#!/usr/bin/env bash
#
# First-boot init for the BEAM wallet-api container.
#
# The wallet-api binary refuses to start without an initialised wallet.db.
# For BeamTerminal we don't need this wallet to ever hold funds — we just need
# a valid identity that can subscribe to gossip and answer
# `assets_swap_offers_list`. So on first boot we:
#
#   1. Generate a fresh BIP-39 seed phrase (or take one from $WALLET_API_SEED).
#   2. Init wallet.db with that seed.
#   3. Persist the seed alongside wallet.db so it survives container restarts
#      and the operator can recover it.
#
# Required env:
#   WALLET_API_NODE_ADDR  e.g. "explorer.0xmx.net:10000"   (P2P, not HTTP)
#   WALLET_API_PASS       wallet.db password (any non-empty string)
#
# Optional:
#   WALLET_API_PORT       JSON-RPC listen port (default 10005)
#   WALLET_API_SEED       use this exact BIP-39 phrase instead of generating
#   WALLET_API_HTTP       "1" → JSON over HTTP, "0" → raw TCP (default 1)
#   WALLET_API_IP_WHITELIST   passed through verbatim
#
# Volume:
#   /data is expected to be mounted; wallet.db + seed.txt live there.

set -euo pipefail

DATA_DIR="/data"
WALLET_DB="${DATA_DIR}/wallet.db"
SEED_FILE="${DATA_DIR}/seed.txt"

: "${WALLET_API_NODE_ADDR:?WALLET_API_NODE_ADDR must be set (e.g. explorer.0xmx.net:10000)}"
: "${WALLET_API_PASS:?WALLET_API_PASS must be set}"

PORT="${WALLET_API_PORT:-10005}"
USE_HTTP="${WALLET_API_HTTP:-1}"

cd "$DATA_DIR"

if [ ! -f "$WALLET_DB" ]; then
  echo "[wallet-api-entrypoint] no wallet.db at $WALLET_DB — initialising"

  if [ -n "${WALLET_API_SEED:-}" ]; then
    PHRASE="$WALLET_API_SEED"
    echo "[wallet-api-entrypoint] using seed from \$WALLET_API_SEED"
  else
    # `generate_phrase` mixes the 12-word phrase into a banner of log lines.
    # The phrase line looks like `<TAB>crime;oval;...;state;` (12 words, each
    # followed by a `;`, leading whitespace, trailing `;`). Pick it out by
    # looking for the (word;){12} shape on any single line, regardless of
    # leading/trailing whitespace.
    PHRASE="$(/opt/beam/beam-wallet generate_phrase 2>&1 \
              | awk -F';' '
                  {
                    line = $0
                    gsub(/^[[:space:]]+|[[:space:]]+$/, "", line)
                    sub(/;$/, "", line)
                    n = split(line, parts, ";")
                    if (n == 12) {
                      ok = 1
                      for (i = 1; i <= 12; i++) if (parts[i] !~ /^[a-z]+$/) { ok = 0; break }
                      if (ok) { print line; exit }
                    }
                  }')"
    if [ -z "$PHRASE" ]; then
      echo "[wallet-api-entrypoint] could not extract phrase from beam-wallet generate_phrase" >&2
      exit 1
    fi
    # Persist so the operator can recover. Restrict perms; the wallet-api
    # process runs as `beam` and is the only consumer.
    umask 077
    printf '%s\n' "$PHRASE" > "$SEED_FILE"
    echo "[wallet-api-entrypoint] generated seed phrase, saved to $SEED_FILE"
  fi

  /opt/beam/beam-wallet init \
    --pass "$WALLET_API_PASS" \
    --seed_phrase "$PHRASE" \
    --wallet_path "$WALLET_DB"

  echo "[wallet-api-entrypoint] wallet initialised"
fi

exec /opt/beam/wallet-api \
  --pass "$WALLET_API_PASS" \
  --node_addr "$WALLET_API_NODE_ADDR" \
  --wallet_path "$WALLET_DB" \
  --port "$PORT" \
  --use_http "$USE_HTTP" \
  --enable_assets \
  ${WALLET_API_IP_WHITELIST:+--ip_whitelist "$WALLET_API_IP_WHITELIST"}

# --enable_assets is required to register the DexBoard subscriber that backs
# `assets_swap_offers_list`; without it the daemon returns
# `Assets Swaps are not enabled` (code -32024). See
# beam/wallet/api/cli/api_cli.cpp:926-933.
