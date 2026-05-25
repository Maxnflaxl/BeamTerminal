-- Precomputed per-trade values so continuous aggregates don't need to JOIN pools.
--
-- price_native = aid2 per 1 aid1 (canonical pool ordering, aid1 < aid2).
-- volume_aid1  = magnitude of aid1 that moved through this trade (groths).
-- volume_aid2  = magnitude of aid2 that moved (groths).
--
-- Indexer populates these at insert time; existing rows can be left NULL
-- and ignored by candle aggregates.
ALTER TABLE trades
  ADD COLUMN price_native NUMERIC(40, 20),
  ADD COLUMN volume_aid1  NUMERIC(40, 0),
  ADD COLUMN volume_aid2  NUMERIC(40, 0);
