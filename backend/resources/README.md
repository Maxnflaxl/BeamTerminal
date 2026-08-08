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

## `pipe_app.wasm`

App-shader for the Beam↔Ethereum bridge Pipe contracts. Needed for the same
reason as above: the explorer's `Parser.wasm` doesn't know the Pipe contract, so
every Pipe call decodes as `Passthrough` with empty arguments and no state is
readable. Running this shader via `wallet-api invoke_contract` (read-only,
`create_tx: false`) is currently the only way to read per-message bridge state.

### Provenance (pinned)

| Field | Value |
| --- | --- |
| Source | `https://github.com/BeamMW/beam-bridge-pipe/blob/master/shaders/pipe_app.wasm` |
| Pinned commit | `597af68bc9a6f3a92dd316ed45283fb3c7efbadc` (2025-05-01, "get status of msg from ethereum") |
| Raw download | `https://raw.githubusercontent.com/BeamMW/beam-bridge-pipe/597af68bc9a6f3a92dd316ed45283fb3c7efbadc/shaders/pipe_app.wasm` |
| SHA-256 | `a53ae07a8a13aca6736bc3b6a5daf608fa4c4c7b25edf2b4a18fd80269c75f83` |
| Size | 8 763 bytes |

**Use this build, not the copies floating around.** Three distinct builds exist:
`6a2ca541…` (7 840 B, 2022-02-23) ships in `beam-bridge-app` and
`beam-bridge-ethrelay`, and `6310f8af…` (5 876 B) in `beam-bridge-reverse-app`.
Neither has `msg_status` — it was only added in the pinned commit above — and
neither has `view_params` (added 2023-01-24).

The Pipe *contract* SID has been frozen at
`38f8c1d41277a8dba733dbfb28dbd530bd83dffe8469312ba93700c1adb26f25` since
2021-12-01, which is the SID of the four b-asset Pipes deployed on mainnet, and
the pinned commit changed only the app shader — so this build reads the state
layout that is actually deployed. `services/bridge.ts` verifies the hash on
first use.

### What it exposes

Read-only manager actions used by the indexer:

- `role=manager,action=local_msg_count,cid=<pipe>` → `{ "count": <n> }`
  — total Beam→Ethereum messages ever created by this Pipe.
- `role=manager,action=local_msg,cid=<pipe>,msgId=<n>` →
  `{ amount, relayerFee, receiver, height }` — `receiver` is a 20-byte
  Ethereum address as hex.
- `role=manager,action=msg_status,cid=<pipe>,msgId=<n>` → `{ "status": 0|1|2 }`
  for Ethereum→Beam messages: `0` never delivered to Beam, `2` delivered and
  awaiting the recipient's claim, `1` claimed. See `services/bridge.ts`.
- `role=manager,action=view_params,cid=<pipe>` →
  `{ "relayer pubkey", "tocken CID" (sic), "token asset ID" }`.
  **Do not call this on the BEAM/WBEAM Pipe** — that contract locks aid 0
  directly instead of pairing with a token contract, so its `Params` record has
  a different layout and the action returns garbage.

`remote_msg` exists but is only useful for messages currently at status 2:
`ReceiveFunds` deletes the message header when the recipient claims
(`pipe_contract.cpp` Method_4), so completed messages report "absent".
