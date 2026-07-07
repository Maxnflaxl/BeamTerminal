-- Server-side cache for the expensive DAO treasury/revenue aggregates, each of
-- which re-scans ~130k vault calls with jsonb_each_text on every request
-- (13-16s). Refreshed in the indexer, served by the API — same idea as
-- dex_stats, but the payloads are JSON so we key a small JSONB table.
CREATE TABLE IF NOT EXISTS dao_stats (
  key          TEXT PRIMARY KEY,
  value        JSONB NOT NULL,
  refreshed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
