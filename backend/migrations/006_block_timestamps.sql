-- Cache of block-height → timestamp lookups.
-- Populated lazily by the indexer (one GET /block per uncached height).
CREATE TABLE block_timestamps (
  height  BIGINT PRIMARY KEY,
  ts      TIMESTAMPTZ NOT NULL
);
