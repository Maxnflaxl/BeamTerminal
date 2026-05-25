-- Hourly roll-up of per-pool reserves for TVL charts.
-- USD valuation happens at query time (multiplied by latest oracle median)
-- because the USD reference is a moving target we don't want to bake in.

CREATE MATERIALIZED VIEW liquidity_1h
WITH (timescaledb.continuous) AS
SELECT pool_id,
       time_bucket(INTERVAL '1 hour', ts) AS bucket,
       last(reserve1, ts)                 AS reserve1,
       last(reserve2, ts)                 AS reserve2,
       last(ctl_supply, ts)               AS ctl_supply
FROM pool_state_snapshots
GROUP BY pool_id, bucket
WITH NO DATA;

SELECT add_continuous_aggregate_policy('liquidity_1h',
  start_offset      => INTERVAL '14 days',
  end_offset        => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour');
