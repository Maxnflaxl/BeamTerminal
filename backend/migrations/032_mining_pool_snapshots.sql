-- Per-pool mining stats snapshots, one row per pool per refresh.
-- Source: each pool's own public stats API (no BEAM-wide pool API exists),
-- polled by the indexer's miningPoolsRefresh task on each new block height.
-- NULL columns mean the pool reported nothing for that field this refresh
-- (mirrors miningpoolstats sentinels: unreachable/idle pools drop fields).
-- Idempotent on (pool_id, ts): re-running a refresh for the same instant is a no-op.
CREATE TABLE IF NOT EXISTS mining_pool_snapshots (
  pool_id           TEXT          NOT NULL,
  ts                TIMESTAMPTZ   NOT NULL,
  hashrate          NUMERIC,           -- Sol/s
  miners            INTEGER,
  workers           INTEGER,
  blocks_24h        INTEGER,
  last_block_height BIGINT,
  last_block_ts     TIMESTAMPTZ,
  fee               NUMERIC,           -- percent
  min_payout        NUMERIC,           -- BEAM
  PRIMARY KEY (pool_id, ts)
);

SELECT create_hypertable('mining_pool_snapshots', 'ts', if_not_exists => TRUE);

-- Latest-per-pool reads order by ts within a pool.
CREATE INDEX IF NOT EXISTS mining_pool_snapshots_pool_ts_idx
  ON mining_pool_snapshots (pool_id, ts DESC);
