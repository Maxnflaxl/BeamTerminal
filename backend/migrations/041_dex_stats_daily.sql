-- Per-day materialization of the all-time DEX volume computation (dexStats.ts).
-- Days older than the confirmation/reorg window are immutable, so the 5-min
-- refresh recomputes only the trailing days and sums the rest from here
-- instead of re-scanning the full trades/pool_state_snapshots/oracle history.
--
-- day        UTC day bucket (time_bucket '1 day'), same bucketing as the query.
-- volume_usd SUM of the day's point-in-time-valued trade volume; NULL when the
--            day had confirmed trades but none were USD-priceable.
-- trades     count of confirmed trades that day.
CREATE TABLE IF NOT EXISTS dex_stats_daily (
  day         TIMESTAMPTZ PRIMARY KEY,
  volume_usd  NUMERIC,
  trades      BIGINT NOT NULL DEFAULT 0
);
