#!/bin/sh
# Configure a Kubo node to join BEAM's private mainnet IPFS swarm.
#
# Runs from `/container-init.d/` inside the `ipfs/kubo` image — that hook fires
# after `ipfs init` and before `ipfs daemon`, exactly once per fresh repo.
#
# The swarm.key and bootstrap addresses come from the open-source BEAM wallet
# (`beam/wallet/ipfs/ipfs_imp.cpp`) and are not secrets. Kept here so the
# private-network config is self-contained and reproducible.
set -eu

echo "[beam-ipfs-init] configuring private mainnet swarm"

# 1. Bootstrap peers — replace the default public-IPFS list with the four
#    eu-node0X.mainnet.beam.mw nodes the wallet ships with.
ipfs bootstrap rm --all
ipfs bootstrap add /dns4/eu-node01.mainnet.beam.mw/tcp/38041/p2p/12D3KooWJFduasQPYWhw4SsoFPmnJ1PXfmHYaA9qYKvn4JKM2hND
ipfs bootstrap add /dns4/eu-node02.mainnet.beam.mw/tcp/38041/p2p/12D3KooWCjmtegxdSkkfutWqty39dwhEhYDWCDj6KCizDtft3sqc
ipfs bootstrap add /dns4/eu-node03.mainnet.beam.mw/tcp/38041/p2p/12D3KooWL5c6JHHkfYLzBjcuot27eyKVhhczvvY617v1cy7QVUHt
ipfs bootstrap add /dns4/eu-node04.mainnet.beam.mw/tcp/38041/p2p/12D3KooWHpgKQYXJMKXQZuwbuRoFK28cQLiVjCVFxhSpFX9XHNWZ

# 2. Private swarm — kill mDNS and the public DHT; only direct dials matter.
ipfs config --json Discovery.MDNS.Enabled false
ipfs config Routing.Type none

# 3. Resource budget — 10 GB cap is plenty for currently-published dapps + a
#    margin for NFT gallery content the same swarm carries.
ipfs config Datastore.StorageMax 10GB

# 4. Bind gateway + API to all interfaces inside the container; docker host
#    bindings further restrict who can reach them. CORS wide open on the
#    gateway so other tools / sites can fetch CIDs from it.
ipfs config Addresses.Gateway /ip4/0.0.0.0/tcp/8080
ipfs config Addresses.API /ip4/0.0.0.0/tcp/5001
ipfs config --json Gateway.HTTPHeaders.Access-Control-Allow-Origin '["*"]'
ipfs config --json Gateway.HTTPHeaders.Access-Control-Allow-Methods '["GET", "HEAD", "OPTIONS"]'

echo "[beam-ipfs-init] done"
