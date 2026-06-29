-- Cache the confirmed-trade count in dex_stats so /api/stats can read it
-- instantly instead of doing a full hypertable count() at request time.
ALTER TABLE dex_stats ADD COLUMN IF NOT EXISTS total_trades BIGINT;
