-- Schema delta to support the proper DApp Store projection driven by the
-- vendored `dapps_store_app.wasm`. The original 026 schema was based on
-- guessed field set; this aligns column names + types with what
-- view_publishers / view_dapps actually return (see
-- backend/resources/README.md for field provenance).

-- dapps.icon was previously called icon_url. The shader returns a hex-encoded
-- blob that, once decoded, is typically a base64-encoded image (PNG/JPG) —
-- not an arbitrary URL. Rename so the column name doesn't lie.
ALTER TABLE dapps RENAME COLUMN icon_url TO icon;

-- ipfs_hash was misleading: the shader's field is named `ipfs_id` and carries
-- an IPFS CID. Rename to match.
ALTER TABLE dapps RENAME COLUMN ipfs_hash TO ipfs_id;

-- The shader exposes min_api_version separately from api_version.
ALTER TABLE dapps ADD COLUMN IF NOT EXISTS min_api_version TEXT;

-- category is an integer enum (Category in beam-ui); store the int and let
-- callers map to names. The old TEXT column was unused (always NULL).
ALTER TABLE dapps DROP COLUMN IF EXISTS category;
ALTER TABLE dapps ADD COLUMN category SMALLINT;

-- Versions of a dapp are exposed via {major,minor,release,build} numerics —
-- preserve them so we can sort + diff correctly without re-parsing the
-- composed "M.m.r.b" string in `version`.
ALTER TABLE dapps ADD COLUMN IF NOT EXISTS version_major   INTEGER;
ALTER TABLE dapps ADD COLUMN IF NOT EXISTS version_minor   INTEGER;
ALTER TABLE dapps ADD COLUMN IF NOT EXISTS version_release INTEGER;
ALTER TABLE dapps ADD COLUMN IF NOT EXISTS version_build   INTEGER;

-- Same for dapp_versions (append-only log).
ALTER TABLE dapp_versions ADD COLUMN IF NOT EXISTS version_major   INTEGER;
ALTER TABLE dapp_versions ADD COLUMN IF NOT EXISTS version_minor   INTEGER;
ALTER TABLE dapp_versions ADD COLUMN IF NOT EXISTS version_release INTEGER;
ALTER TABLE dapp_versions ADD COLUMN IF NOT EXISTS version_build   INTEGER;
-- And the recorded source of each version row — 'projection' for entries
-- derived from a view_dapps poll (cleaned + repopulated each refresh).
ALTER TABLE dapp_versions ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'projection';

-- Publisher dapps_count is now derivable from the dapps table; nothing to
-- store on the publisher row itself. (For completeness — no schema change.)
