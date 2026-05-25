-- Idempotency note: we do NOT have a kernel hash from the explorer
-- (the "Keys" column in /contract Calls history is empty on observed builds).
-- We rely on the indexer cursor advancing exactly once per height — re-ingest
-- of a height range only happens on a reorg-rewind path which DELETEs first.
CREATE TABLE trades (
  trade_id    BIGINT GENERATED ALWAYS AS IDENTITY,
  pool_id     BIGINT NOT NULL REFERENCES pools(pool_id),
  height      BIGINT NOT NULL,
  block_ts    TIMESTAMPTZ NOT NULL,
  aid_in      BIGINT NOT NULL,
  aid_out     BIGINT NOT NULL,
  -- Always positive groths. The sign convention from the explorer ("+/-")
  -- is normalized to magnitudes here; direction is encoded in (aid_in, aid_out).
  amount_in   NUMERIC(40, 0) NOT NULL,
  amount_out  NUMERIC(40, 0) NOT NULL,
  confirmed   BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (trade_id, block_ts)
);

SELECT create_hypertable('trades', 'block_ts', chunk_time_interval => INTERVAL '7 days');

CREATE INDEX trades_pool_ts_idx  ON trades (pool_id, block_ts DESC);
CREATE INDEX trades_height_idx   ON trades (height);
-- Partial index makes the "promote to confirmed" UPDATE cheap.
CREATE INDEX trades_unconfirmed_height_idx
  ON trades (height)
  WHERE confirmed = FALSE;
