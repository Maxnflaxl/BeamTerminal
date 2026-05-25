-- Per-block network metrics for the network-charts page (hashrate,
-- kernels/day). Populated by a one-shot full-chain backfill plus a
-- steady-state catch-up loop in the indexer. Daily aggregation
-- happens in the API via time_bucket().
CREATE TABLE block_metrics (
  height        BIGINT NOT NULL,
  block_ts      TIMESTAMPTZ NOT NULL,
  -- /block.chainwork is a cumulative hex/decimal-encoded big integer.
  -- Stored as NUMERIC so daily hashrate = (chainwork - LAG(chainwork)) / dt.
  chainwork     NUMERIC(80, 0) NOT NULL,
  -- Count of kernels in this block (length of /block.kernels).
  kernels       INTEGER NOT NULL,
  -- /block.difficulty (per-block target).
  difficulty    DOUBLE PRECISION NOT NULL,
  -- Composite PK including the partitioning column (TimescaleDB requirement).
  -- Idempotent upserts in services/blockMetrics.ts use `ON CONFLICT (height, block_ts)`.
  PRIMARY KEY (height, block_ts)
);

SELECT create_hypertable('block_metrics', 'block_ts', chunk_time_interval => INTERVAL '90 days');

CREATE INDEX block_metrics_height_idx ON block_metrics (height);

-- On-chain registration height for assets. Distinct from first_seen_height,
-- which only records when our indexer first observed the asset.
ALTER TABLE assets ADD COLUMN IF NOT EXISTS lock_height BIGINT;
CREATE INDEX IF NOT EXISTS assets_lock_height_idx ON assets (lock_height);
