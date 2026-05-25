-- Track the height at which `refresh_continuous_aggregate(..., NULL, NULL)`
-- was last completed. Lets the indexer re-run the full refresh on startup
-- when a crash interrupted backfill between writing trades and refreshing the
-- aggregates — otherwise the candle views would be permanently missing those
-- buckets (auto-refresh policies only cover the most recent `start_offset`).
ALTER TABLE cursor
  ADD COLUMN IF NOT EXISTS aggregates_refreshed_at_height BIGINT NOT NULL DEFAULT 0;
