CREATE TABLE pool_state_snapshots (
  pool_id     BIGINT NOT NULL REFERENCES pools(pool_id),
  height      BIGINT NOT NULL,
  ts          TIMESTAMPTZ NOT NULL,
  reserve1    NUMERIC(40, 0) NOT NULL,  -- groths of aid1 in pool
  reserve2    NUMERIC(40, 0) NOT NULL,  -- groths of aid2 in pool
  ctl_supply  NUMERIC(40, 0) NOT NULL,  -- LP token total supply (groths of aid_ctl)
  PRIMARY KEY (pool_id, ts)
);

SELECT create_hypertable('pool_state_snapshots', 'ts', chunk_time_interval => INTERVAL '7 days');

CREATE INDEX pool_state_snapshots_height_idx ON pool_state_snapshots (height);
