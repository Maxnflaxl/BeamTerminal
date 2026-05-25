CREATE TABLE lp_events (
  event_id    BIGINT GENERATED ALWAYS AS IDENTITY,
  pool_id     BIGINT NOT NULL REFERENCES pools(pool_id),
  height      BIGINT NOT NULL,
  block_ts    TIMESTAMPTZ NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('Deposit', 'Withdraw')),
  -- Always positive magnitudes (Funds-side: amount of aid1 / aid2 added or removed).
  amount1     NUMERIC(40, 0) NOT NULL,
  amount2     NUMERIC(40, 0) NOT NULL,
  -- LP tokens minted (Deposit) or burned (Withdraw). Positive magnitude.
  amount_ctl  NUMERIC(40, 0) NOT NULL,
  confirmed   BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (event_id, block_ts)
);

SELECT create_hypertable('lp_events', 'block_ts', chunk_time_interval => INTERVAL '7 days');

CREATE INDEX lp_events_pool_ts_idx  ON lp_events (pool_id, block_ts DESC);
CREATE INDEX lp_events_height_idx   ON lp_events (height);
CREATE INDEX lp_events_unconfirmed_height_idx
  ON lp_events (height)
  WHERE confirmed = FALSE;
