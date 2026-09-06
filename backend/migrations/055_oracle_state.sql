-- Single-row projection of the Oracle2 contract, written by the indexer from
-- the `oracle2_app.wasm` shader (wallet-api invoke_contract). The API serves
-- /api/oracle straight out of this row so the page never depends on the
-- wallet-api daemon being reachable.
--
-- Distinct from `oracle_snapshots`, which is a time series of the median price
-- for charting; this is the current state of the feed (providers, settings,
-- stored median validity).
CREATE TABLE IF NOT EXISTS oracle_state (
  id             INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  cid            TEXT        NOT NULL,
  kind           TEXT,                      -- explorer's contract label, e.g. "Oracle2 v0"
  height         BIGINT      NOT NULL,      -- chain tip the snapshot was taken at
  h_validity     INT         NOT NULL,      -- blocks an entry stays valid for
  min_providers  INT         NOT NULL,
  median_value   NUMERIC,                   -- stored median, NULL when never reached quorum
  median_h_end   BIGINT      NOT NULL,      -- height the stored median is valid through
  providers      JSONB       NOT NULL,      -- [{ index, pk, value, h_updated }, …]
  refreshed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
