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

## `oracle2_app.wasm`

App-shader for the Oracle2 contract (`ORACLE_CID`). The explorer decodes the
oracle's state well enough for the median price the indexer needs, but not the
stored `Median.m_hEnd` — the height the last written median stays valid
through, which is what separates "no quorum right now" from "a median that is
simply old". The shader reads both `s_StateFull` and `s_Median` directly.

### Provenance (pinned)

| Field | Value |
| --- | --- |
| Source | `https://github.com/BeamMW/beam/blob/master/bvm/Shaders/oracle2/app.wasm` |
| Pinned commit | `24fee817b089c7609d9f4e2e6fde7edbf906adba` (BeamMW/beam#2087, "oracle2: fix app shader response documents") |
| SHA-256 | `828f0efedaa38a32b44fa2a77a3fbf22a57d6dc37f10d2ad704d62013a3aa899` |
| Size | 22 621 bytes |

**Older builds are unusable here.** Before #2087 `view_median` opened a
`DocArray` and wrote named fields into it, producing `{"res": ["val": 0,…]}` —
not parseable JSON — and `view_params` did not emit `hValidity` /
`nMinProviders`, so a caller could not tell why a feed had no quorum or which
entries were stale. Only the app shader changed; `ShaderID` hashes
`contract.wasm`, so the deployed ContractID is unaffected.

### What it exposes

Read-only manager actions used by the indexer:

- `role=manager,action=view_params,cid=<ORACLE_CID>` →
  `{ "params": { "hValidity": 220, "nMinProviders": 3,
                 "provs": [ { pk, val, hUpd }, … ] } }`
  — `val` is the provider's feed value scaled by 1e9 (`get_Norm_n`), `hUpd`
  the height it was last written. An entry is stale once
  `tip - hUpd > hValidity`.
- `role=manager,action=view_median,cid=<ORACLE_CID>` →
  `{ "res": { "val": <price × 1e9>, "hEnd": <height> } }` — the *stored*
  median, recomputed only when a provider writes to the contract. `hEnd: 0`
  means no median has ever reached quorum since the last settings change.

`services/oracle2.ts` verifies the hash on first use.
