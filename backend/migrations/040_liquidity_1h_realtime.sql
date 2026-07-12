-- The /pairs/:id/liquidity source=total series is served from liquidity_1h.
-- Real-time aggregation makes the view include the not-yet-materialized tail
-- (the refresh policy's end_offset is 1 hour), so reads match the raw table
-- regardless of the TimescaleDB version's default for materialized_only.
ALTER MATERIALIZED VIEW liquidity_1h SET (timescaledb.materialized_only = false);
