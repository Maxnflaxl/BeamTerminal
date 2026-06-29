-- Per-pool self-reported found blocks, used to attribute network blocks to pools
-- on the Mining page (BEAM blocks carry no on-chain pool tag; we aggregate what
-- each pool's API/stats page reports it found — the same method miningpoolstats uses).
-- Height-keyed per pool: idempotent, dedupes, and reorg-tolerant.
CREATE TABLE IF NOT EXISTS mining_pool_blocks (
  pool_id       TEXT        NOT NULL,
  height        BIGINT      NOT NULL,
  found_ts      TIMESTAMPTZ,                 -- pool-reported time, when available
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (pool_id, height)
);
CREATE INDEX IF NOT EXISTS mining_pool_blocks_height_idx ON mining_pool_blocks (height);
