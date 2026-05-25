-- Single-row cache for slow API aggregates. The /api/stats `total_volume_usd`
-- figure scans the full `trades` table with hourly time-bucketing and lateral
-- joins per bucket; behind a CF Tunnel (~100s edge timeout) the request 524s.
-- The indexer recomputes this on a timer and the API reads it instantly.
CREATE TABLE dex_stats (
  id                INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  total_volume_usd  NUMERIC,
  refreshed_at      TIMESTAMPTZ
);

INSERT INTO dex_stats (id) VALUES (1);
