CREATE TABLE oracle_snapshots (
  ts        TIMESTAMPTZ NOT NULL,
  height    BIGINT NOT NULL,
  beam_usd  NUMERIC(20, 8) NOT NULL,
  h_end     BIGINT NOT NULL,
  PRIMARY KEY (ts)
);

SELECT create_hypertable('oracle_snapshots', 'ts', chunk_time_interval => INTERVAL '30 days');

CREATE INDEX oracle_snapshots_height_idx ON oracle_snapshots (height DESC);
