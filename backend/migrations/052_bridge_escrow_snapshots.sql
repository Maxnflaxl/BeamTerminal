-- bridge_escrow holds one current row per bridge, so the moment a sync
-- overwrites it the previous reading is gone. TVL history is therefore
-- reconstructed from message flow (see services/bridgeTvl.ts) for everything
-- before this table existed, and measured from here on.
CREATE TABLE IF NOT EXISTS bridge_escrow_snapshots (
  bridge          TEXT           NOT NULL,
  chain_id        INTEGER        NOT NULL,
  locked          NUMERIC(40, 0) NOT NULL,
  decimals        INTEGER        NOT NULL,
  minted          NUMERIC(40, 0),
  minted_decimals INTEGER,
  block_number    BIGINT,
  observed_at     TIMESTAMPTZ    NOT NULL DEFAULT now(),
  PRIMARY KEY (bridge, observed_at)
);

SELECT create_hypertable('bridge_escrow_snapshots', 'observed_at',
                         if_not_exists => TRUE, migrate_data => TRUE);

CREATE INDEX IF NOT EXISTS bridge_escrow_snapshots_bridge_idx
  ON bridge_escrow_snapshots (bridge, observed_at DESC);
