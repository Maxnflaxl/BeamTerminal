-- Serves the correlated "snapshot at/before or at/after a height for one pool"
-- probes (trades.ts ctl_after, historical_price.ts reserves-at-height) as a
-- single per-chunk seek. Without it those probes walk the bare height index
-- discarding other pools' rows.
CREATE INDEX IF NOT EXISTS pool_state_snapshots_pool_height_idx
  ON pool_state_snapshots (pool_id, height);
