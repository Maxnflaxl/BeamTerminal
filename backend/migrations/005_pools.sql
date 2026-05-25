CREATE TABLE pools (
  pool_id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  aid1                 BIGINT NOT NULL REFERENCES assets(aid),
  aid2                 BIGINT NOT NULL REFERENCES assets(aid),
  -- Volatility tier: 0=Low(0.05%), 1=Medium(0.3%), 2=High(1.0%)
  kind                 SMALLINT NOT NULL CHECK (kind IN (0, 1, 2)),
  -- LP token AID — every pool has its own
  aid_ctl              BIGINT NOT NULL REFERENCES assets(aid),
  created_at_height    BIGINT NOT NULL,
  created_at_ts        TIMESTAMPTZ,
  destroyed_at_height  BIGINT,
  UNIQUE (aid1, aid2, kind)
);

CREATE INDEX pools_aid1_idx    ON pools (aid1);
CREATE INDEX pools_aid2_idx    ON pools (aid2);
CREATE INDEX pools_aid_ctl_idx ON pools (aid_ctl);
