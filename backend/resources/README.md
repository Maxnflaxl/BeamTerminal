# Vendored shader binaries

## `dapps_store_app.wasm`

App-shader (wallet-side) wrapping every call to the BEAM DApp Store registry
contract. We host it server-side because:

- The DApp Store contract sits behind the `upgradable2` wrapper, so the
  explorer cannot decode dapp/publisher state for us.
- The wallet's local shader is the only widely-used decoder. Running it via
  `wallet-api invoke_contract` (read-only, `create_tx: false`) returns the
  full `view_publishers` / `view_dapps` JSON we project into Postgres.

### Provenance (pinned)

| Field | Value |
| --- | --- |
| Source | `https://github.com/BeamMW/beam-ui/blob/master/ui/dapps_store_app.wasm` |
| Pinned commit | `d50c3ae2be14ab1c2a883ab6a4089665fcb56dd3` (2022-04-03) |
| Raw download | `https://raw.githubusercontent.com/BeamMW/beam-ui/d50c3ae2be14ab1c2a883ab6a4089665fcb56dd3/ui/dapps_store_app.wasm` |
| SHA-256 | `14d9d11bb0f6f66d290e7fd3d2949599867b3446e1bf3432544d87109476b95b` |
| Size | 9 788 bytes |

The wasm has been stable since April 2022 and matches the copy bundled with
every desktop / iOS / Android wallet shipped to date. If you need to bump it,
update both the pinned commit and the SHA-256 here; `services/dappStore.ts`
verifies the hash at startup.

### What it exposes

Read-only actions used by the indexer:

- `action=view_publishers,cid=<DAPP_STORE_CID>` →
  `{ "publishers": [ { pubkey, name, short_title, about_me, website,
                       twitter, linkedin, instagram, telegram, discord, … }, … ] }`
- `action=view_dapps,cid=<DAPP_STORE_CID>` →
  `{ "dapps": [ { id, publisher, name, description, ipfs_id, icon, category,
                  api_version, min_api_version,
                  version: { major, minor, release, build } }, … ] }`

All `string`-typed fields except `pubkey`, `id`, `ipfs_id`, `publisher`
are hex-encoded UTF-8 (matches `beam-ui/ui/viewmodel/applications/apps_view.cpp::decodeStringField`).
