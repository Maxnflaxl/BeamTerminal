-- DApp Store call activity, scraped from the explorer's /contract calls-history
-- table. The DApp Store contract sits behind `upgradable2`, so the explorer
-- can't decode the arguments — but it does tell us, for every call:
--   - the block height + timestamp,
--   - the inner-contract method id (3..7),
--   - a single 33-byte blob argument, which mainnet data shows is the
--     publisher's pubkey.
--
-- That's enough to derive real first_seen / last_updated timestamps for
-- publishers (previously stamped now() because view_publishers / view_dapps
-- have no height fields).
--
-- The earlier 026 migration created `dapp_store_raw_calls` keyed by
-- (kernel_id, call_index). Nothing ever populated it, because the explorer's
-- /contract response does not surface kernel_id on passthrough rows. This
-- table uses (height, ord) as the natural key instead — `ord` is the row's
-- 0-based index *within its height*, preserving the explorer's stable order
-- for blocks that contain multiple DApp Store calls.
CREATE TABLE IF NOT EXISTS dapp_store_calls (
  height            BIGINT       NOT NULL,
  ord               INTEGER      NOT NULL,
  block_ts          TIMESTAMPTZ  NOT NULL,
  publisher_pubkey  TEXT         NOT NULL,
  -- Inner-contract method id from the upgradable2 passthrough call.
  -- Empirically (cross-referenced with beam-ui apps_view.cpp action order):
  --   3 = add_publisher
  --   4 = update_publisher
  --   5 = add_dapp
  --   6 = update_dapp
  --   7 = delete_dapp
  method            SMALLINT     NOT NULL,
  PRIMARY KEY (height, ord)
);

CREATE INDEX IF NOT EXISTS dapp_store_calls_pubkey_idx
  ON dapp_store_calls (publisher_pubkey, height);

CREATE INDEX IF NOT EXISTS dapp_store_calls_method_idx
  ON dapp_store_calls (method, height DESC);
