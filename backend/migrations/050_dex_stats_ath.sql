-- All-time high BEAM/USD, cached alongside the other slow aggregates.
--
-- `SELECT beam_usd, ts FROM oracle_snapshots ORDER BY beam_usd DESC LIMIT 1`
-- is a full scan of a hypertable with no index on beam_usd, and /api/stats is
-- a 20ms hot-path endpoint served on every page load. Same reasoning as
-- total_volume_usd in 015: the indexer computes it on a timer, the API reads a
-- single row.
ALTER TABLE dex_stats ADD COLUMN IF NOT EXISTS ath_usd NUMERIC;
ALTER TABLE dex_stats ADD COLUMN IF NOT EXISTS ath_ts  TIMESTAMPTZ;
