-- Continuous aggregates over `trades` — one per chart timeframe.
-- Filter: `confirmed = TRUE` + `price_native > 0` (skip pre-Slice-3 rows
-- where the column is NULL, and skip degenerate-direction trades).
--
-- `price_native` is aid2-per-aid1 in the pool's canonical ordering.
-- `volume_aid1` / `volume_aid2` are magnitudes (groths).
-- Continuous aggregates refresh on a schedule; readers see snapshots from
-- the last refresh interval (plus real-time data via WITH MATERIALIZED option
-- defaults — recent data is computed on-the-fly).

CREATE MATERIALIZED VIEW candles_1m
WITH (timescaledb.continuous) AS
SELECT pool_id,
       time_bucket(INTERVAL '1 minute', block_ts)  AS bucket,
       first(price_native, block_ts)              AS open,
       max(price_native)                           AS high,
       min(price_native)                           AS low,
       last(price_native, block_ts)               AS close,
       sum(volume_aid1)                            AS volume_aid1,
       sum(volume_aid2)                            AS volume_aid2,
       count(*)                                    AS trade_count
FROM trades
WHERE confirmed = TRUE AND price_native IS NOT NULL AND price_native > 0
GROUP BY pool_id, bucket
WITH NO DATA;

SELECT add_continuous_aggregate_policy('candles_1m',
  start_offset      => INTERVAL '6 hours',
  end_offset        => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute');


CREATE MATERIALIZED VIEW candles_5m
WITH (timescaledb.continuous) AS
SELECT pool_id,
       time_bucket(INTERVAL '5 minutes', block_ts) AS bucket,
       first(price_native, block_ts)              AS open,
       max(price_native)                           AS high,
       min(price_native)                           AS low,
       last(price_native, block_ts)               AS close,
       sum(volume_aid1)                            AS volume_aid1,
       sum(volume_aid2)                            AS volume_aid2,
       count(*)                                    AS trade_count
FROM trades
WHERE confirmed = TRUE AND price_native IS NOT NULL AND price_native > 0
GROUP BY pool_id, bucket
WITH NO DATA;

SELECT add_continuous_aggregate_policy('candles_5m',
  start_offset      => INTERVAL '24 hours',
  end_offset        => INTERVAL '5 minutes',
  schedule_interval => INTERVAL '5 minutes');


CREATE MATERIALIZED VIEW candles_15m
WITH (timescaledb.continuous) AS
SELECT pool_id,
       time_bucket(INTERVAL '15 minutes', block_ts) AS bucket,
       first(price_native, block_ts)               AS open,
       max(price_native)                            AS high,
       min(price_native)                            AS low,
       last(price_native, block_ts)                AS close,
       sum(volume_aid1)                             AS volume_aid1,
       sum(volume_aid2)                             AS volume_aid2,
       count(*)                                     AS trade_count
FROM trades
WHERE confirmed = TRUE AND price_native IS NOT NULL AND price_native > 0
GROUP BY pool_id, bucket
WITH NO DATA;

SELECT add_continuous_aggregate_policy('candles_15m',
  start_offset      => INTERVAL '3 days',
  end_offset        => INTERVAL '15 minutes',
  schedule_interval => INTERVAL '15 minutes');


CREATE MATERIALIZED VIEW candles_1h
WITH (timescaledb.continuous) AS
SELECT pool_id,
       time_bucket(INTERVAL '1 hour', block_ts) AS bucket,
       first(price_native, block_ts)           AS open,
       max(price_native)                        AS high,
       min(price_native)                        AS low,
       last(price_native, block_ts)            AS close,
       sum(volume_aid1)                         AS volume_aid1,
       sum(volume_aid2)                         AS volume_aid2,
       count(*)                                 AS trade_count
FROM trades
WHERE confirmed = TRUE AND price_native IS NOT NULL AND price_native > 0
GROUP BY pool_id, bucket
WITH NO DATA;

SELECT add_continuous_aggregate_policy('candles_1h',
  start_offset      => INTERVAL '14 days',
  end_offset        => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour');


CREATE MATERIALIZED VIEW candles_4h
WITH (timescaledb.continuous) AS
SELECT pool_id,
       time_bucket(INTERVAL '4 hours', block_ts) AS bucket,
       first(price_native, block_ts)            AS open,
       max(price_native)                         AS high,
       min(price_native)                         AS low,
       last(price_native, block_ts)             AS close,
       sum(volume_aid1)                          AS volume_aid1,
       sum(volume_aid2)                          AS volume_aid2,
       count(*)                                  AS trade_count
FROM trades
WHERE confirmed = TRUE AND price_native IS NOT NULL AND price_native > 0
GROUP BY pool_id, bucket
WITH NO DATA;

SELECT add_continuous_aggregate_policy('candles_4h',
  start_offset      => INTERVAL '30 days',
  end_offset        => INTERVAL '4 hours',
  schedule_interval => INTERVAL '4 hours');


CREATE MATERIALIZED VIEW candles_1d
WITH (timescaledb.continuous) AS
SELECT pool_id,
       time_bucket(INTERVAL '1 day', block_ts) AS bucket,
       first(price_native, block_ts)          AS open,
       max(price_native)                       AS high,
       min(price_native)                       AS low,
       last(price_native, block_ts)           AS close,
       sum(volume_aid1)                        AS volume_aid1,
       sum(volume_aid2)                        AS volume_aid2,
       count(*)                                AS trade_count
FROM trades
WHERE confirmed = TRUE AND price_native IS NOT NULL AND price_native > 0
GROUP BY pool_id, bucket
WITH NO DATA;

SELECT add_continuous_aggregate_policy('candles_1d',
  start_offset      => INTERVAL '90 days',
  end_offset        => INTERVAL '1 day',
  schedule_interval => INTERVAL '1 day');
