-- BEAM DApp Store registry — the on-chain contract whose mainnet CID is
-- e2d24b686e8d31a0fe97eade9cd23281e7059b74b5757bdb96c820ef9e2af41c. The wallet
-- ships a local app-shader (`dapps_store_app.wasm`) that wraps every call;
-- four mutating actions exist (CreatePublisher, UpdatePublisher, UploadDApp,
-- DeleteDApp). We index calls to that CID via the same code path that ingests
-- DEX calls — different CID, different parser.
--
-- The shader argument schema is not documented; the indexer parser
-- (services/dappStore.ts) reconstructs it incrementally from observed call
-- rows + the beam-ui viewmodel as ground truth. Until parsing is wired up
-- end-to-end, only `dapp_store_raw_calls` is populated — the publisher /
-- dapp views below are derived from it.

-- One row per call to DAPP_STORE_CID. Reorg-safe: cleaned by the existing
-- reorg path the same way it cleans `trades` / `lp_events` (height-keyed).
CREATE TABLE IF NOT EXISTS dapp_store_raw_calls (
  kernel_id     TEXT          NOT NULL,
  -- 0-based index within the kernel for grouped calls (DApp Store actions
  -- typically aren't grouped, but the explorer can return group rows).
  call_index    INTEGER       NOT NULL DEFAULT 0,
  height        BIGINT        NOT NULL,
  block_ts      TIMESTAMPTZ   NOT NULL,
  -- Shader action enum value (CreatePublisher=0, UpdatePublisher=1, ...).
  -- Resolved from the call's first argument cell when present; NULL when the
  -- explorer surfaced an unparseable row.
  action        SMALLINT,
  -- Raw arguments cell array as returned by the explorer, JSON-encoded so we
  -- can re-parse with smarter logic later without re-fetching from the
  -- explorer.
  args          JSONB         NOT NULL,
  confirmed     BOOLEAN       NOT NULL DEFAULT FALSE,
  PRIMARY KEY (kernel_id, call_index)
);

CREATE INDEX IF NOT EXISTS dapp_store_raw_calls_height_idx
  ON dapp_store_raw_calls (height);

CREATE INDEX IF NOT EXISTS dapp_store_raw_calls_action_idx
  ON dapp_store_raw_calls (action, height DESC);

-- Publisher registry. One row per CreatePublisher action, mutated by
-- UpdatePublisher. `pubkey` is the publisher's on-chain identity; everything
-- else is metadata (typically a JSON blob in the call arg).
CREATE TABLE IF NOT EXISTS dapp_publishers (
  pubkey         TEXT          PRIMARY KEY,
  name           TEXT,
  short_title    TEXT,
  about_me       TEXT,
  website        TEXT,
  twitter        TEXT,
  linkedin       TEXT,
  instagram      TEXT,
  telegram       TEXT,
  discord        TEXT,
  first_seen_height BIGINT     NOT NULL,
  first_seen_at  TIMESTAMPTZ   NOT NULL,
  last_updated_height BIGINT   NOT NULL,
  last_updated_at TIMESTAMPTZ  NOT NULL,
  -- Raw last-seen publisher payload for forward-compat; useful while we're
  -- still iterating on the parser.
  raw_payload    JSONB
);

-- Registered dapps. `id` is the on-chain registry id (whatever the shader
-- assigns); `publisher_pubkey` references dapp_publishers.pubkey.
CREATE TABLE IF NOT EXISTS dapps (
  id             TEXT          PRIMARY KEY,
  publisher_pubkey TEXT        NOT NULL REFERENCES dapp_publishers(pubkey),
  name           TEXT,
  description    TEXT,
  category       TEXT,
  icon_url       TEXT,
  ipfs_hash      TEXT,
  api_version    TEXT,
  version        TEXT,
  first_seen_height BIGINT     NOT NULL,
  first_seen_at  TIMESTAMPTZ   NOT NULL,
  last_updated_height BIGINT   NOT NULL,
  last_updated_at TIMESTAMPTZ  NOT NULL,
  deleted_at     TIMESTAMPTZ,
  deleted_at_height BIGINT,
  raw_payload    JSONB
);

CREATE INDEX IF NOT EXISTS dapps_publisher_idx
  ON dapps (publisher_pubkey)
  WHERE deleted_at IS NULL;

-- Append-only per-dapp version log so we can render "v0.3 published at H,
-- v0.4 at H+200" timelines. UploadDApp + DeleteDApp both emit a row.
CREATE TABLE IF NOT EXISTS dapp_versions (
  dapp_id        TEXT          NOT NULL,
  version        TEXT,
  ipfs_hash      TEXT,
  height         BIGINT        NOT NULL,
  block_ts       TIMESTAMPTZ   NOT NULL,
  action         SMALLINT      NOT NULL,  -- mirrors dapp_store_raw_calls.action
  PRIMARY KEY (dapp_id, height, action)
);
