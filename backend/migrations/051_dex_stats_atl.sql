-- All-time low BEAM/USD, cached beside the high.
--
-- Separate from 050 rather than folded into it: 050 may already be recorded in
-- schema_migrations, and a migration that has run does not run again — the
-- columns would silently never appear.
--
-- Unlike the high, the low needs no known-value floor. BEAM's all-time low is
-- $0.00616752 on 2026-07-03, comfortably inside the window this indexer covers
-- (oracle_snapshots begins 2022-08-13), so min(oracle_snapshots) is the real
-- figure. The high sits in 2019 and does not — see 050.
ALTER TABLE dex_stats ADD COLUMN IF NOT EXISTS atl_usd NUMERIC;
ALTER TABLE dex_stats ADD COLUMN IF NOT EXISTS atl_ts  TIMESTAMPTZ;
