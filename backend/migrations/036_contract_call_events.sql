-- Generic call-history log for "watched" contracts (BANS first; DAO / others
-- later). Mirrors the (height, ord) natural key of dapp_store_calls because the
-- explorer exposes no tx/kernel hash on calls-history rows. `ord` is the 0-based
-- index within (cid, height), preserving the explorer's stable order for blocks
-- with multiple calls. Nested calls (Oracle Get, DaoVault Deposit under a BANS
-- Register) are stored too, linked via parent_ord, so revenue can be attributed
-- later without re-scraping.
CREATE TABLE IF NOT EXISTS contract_call_events (
  cid         TEXT        NOT NULL,
  height      BIGINT      NOT NULL,
  ord         INTEGER     NOT NULL,
  block_ts    TIMESTAMPTZ NOT NULL,
  parent_ord  INTEGER,               -- NULL = primary call; else ord of the primary it nests under
  target_cid  TEXT,                  -- contract actually invoked (nested rows); '' = the watched contract itself
  kind        TEXT,                  -- explorer 'Kind' column (e.g. 'DaoVault v0')
  method      TEXT        NOT NULL,
  name        TEXT,                  -- args.name / args.Name when present (the BANS domain)
  args        JSONB,
  funds       JSONB,                 -- signed aid->groth funds table; NULL when absent
  PRIMARY KEY (cid, height, ord)
);

CREATE INDEX IF NOT EXISTS cce_cid_method_height_idx ON contract_call_events (cid, method, height DESC);
CREATE INDEX IF NOT EXISTS cce_cid_parent_idx        ON contract_call_events (cid, parent_ord, height);
CREATE INDEX IF NOT EXISTS cce_target_method_idx     ON contract_call_events (target_cid, method, height DESC);

-- Per-contract backfill/resume cursor. Also the reorg rewind target.
CREATE TABLE IF NOT EXISTS contract_activity_cursor (
  cid                 TEXT   PRIMARY KEY,
  last_indexed_height BIGINT NOT NULL DEFAULT 0
);
