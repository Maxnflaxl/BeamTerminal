-- Track the chain head the indexer observed on each tick so /api/health
-- can render a "X blocks behind" badge in the UI without an extra explorer
-- round-trip.
ALTER TABLE cursor ADD COLUMN IF NOT EXISTS last_chain_head BIGINT NOT NULL DEFAULT 0;
