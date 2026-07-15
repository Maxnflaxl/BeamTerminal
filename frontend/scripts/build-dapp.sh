#!/usr/bin/env bash
set -euo pipefail

DAPP_NAME="beamterminal"
MANIFEST_NAME="BeamTerminal"
MANIFEST_DESCRIPTION="Beam DEX terminal — pairs, charts, trades, swap."
MANIFEST_VERSION_PREFIX="1.0"
MANIFEST_ICON="localapp/app/favicon.svg"
MANIFEST_URL="localapp/app/index.html"
MANIFEST_API_VERSION="7.3"
MANIFEST_MIN_API_VERSION="7.3"
MANIFEST_GUID="d5669ebc08394e15a394011a8020dd9a"

COMMIT_COUNT="$(git rev-list --count HEAD)"
VERSION="${MANIFEST_VERSION_PREFIX}.${COMMIT_COUNT}"

yarn install
yarn build:prod

test -f html/index.html
# Bundle filenames carry a contenthash — glob instead of exact names.
ls html/index.*.js > /dev/null
ls html/styles.*.css > /dev/null
# The DApp Store icon is the site favicon, which webpack copies into html/.
test -f html/favicon.svg

# Drop any prior build, including a stale copy sitting in html/ from a previous
# run — otherwise `cp -r html/*` below would bundle the .dapp inside itself.
rm -rf "${DAPP_NAME}" "${DAPP_NAME}.dapp" "html/${DAPP_NAME}.dapp"
mkdir -p "${DAPP_NAME}/app"
cp -r html/* "${DAPP_NAME}/app/"

# Inside the wallet the connector always uses the qwebchannel bridge — the
# headless wasm client is unreachable there. Keep it in html/ for the website.
rm -f "${DAPP_NAME}/app/wasm-client.js" \
      "${DAPP_NAME}/app/wasm-client.wasm" \
      "${DAPP_NAME}/app/wasm-client.worker.js"

cat > "${DAPP_NAME}/manifest.json" <<EOF
{
  "name": "${MANIFEST_NAME}",
  "description": "${MANIFEST_DESCRIPTION}",
  "icon": "${MANIFEST_ICON}",
  "url": "${MANIFEST_URL}",
  "version": "${VERSION}",
  "api_version": "${MANIFEST_API_VERSION}",
  "min_api_version": "${MANIFEST_MIN_API_VERSION}",
  "guid": "${MANIFEST_GUID}"
}
EOF

(
  cd "${DAPP_NAME}"
  zip -r "../${DAPP_NAME}.dapp" ./*
)

# Publish the bundle into html/ so the deploy's `rsync html/ → /var/www` step
# serves it at the web root for the nav's "Download DApp" button (/beamterminal.dapp).
cp "${DAPP_NAME}.dapp" "html/${DAPP_NAME}.dapp"

echo "Created ${DAPP_NAME}.dapp (also copied to html/) with version ${VERSION}"
