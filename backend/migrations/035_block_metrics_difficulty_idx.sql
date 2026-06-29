-- Index on block_metrics.difficulty to speed up the herominers height-resolution
-- query in refresh.ts (SELECT … WHERE difficulty = ANY($1::float8[])).
-- Without this the query does a full hypertable scan on every indexer refresh.
CREATE INDEX IF NOT EXISTS block_metrics_difficulty_idx ON block_metrics (difficulty);
