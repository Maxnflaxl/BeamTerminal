-- Heal duplicate rows in `trades` and `lp_events`, then add unique indexes so
-- future re-runs of an already-ingested height range are safe.
--
-- Background: the original schema relied on "the indexer advances its cursor
-- exactly once per height" for idempotency. A crash between INSERT and
-- updateCursor (or any other re-ingest path) silently duplicated trades.
-- Production data was running ~6× inflated (247K rows for 41K real trades).
--
-- Limitation: the natural key dedupe will collapse two legitimately-identical
-- trades in the same block (same pool, side, amounts) to one row. On-chain
-- this is vanishingly rare for AMMs (slippage tolerances make exact-match
-- duplicates almost impossible) and the alternative — keeping known dupes —
-- corrupts every downstream aggregate. The Calls history response from the
-- explorer doesn't expose a kernel/tx hash, so we can't disambiguate further.

-- ---------------------------------------------------------------------------
-- trades
-- ---------------------------------------------------------------------------

DELETE FROM trades a
USING trades b
WHERE a.trade_id > b.trade_id
  AND a.pool_id     = b.pool_id
  AND a.height      = b.height
  AND a.block_ts    = b.block_ts
  AND a.aid_in      = b.aid_in
  AND a.aid_out     = b.aid_out
  AND a.amount_in   = b.amount_in
  AND a.amount_out  = b.amount_out;

CREATE UNIQUE INDEX IF NOT EXISTS trades_natural_key_idx
  ON trades (pool_id, height, aid_in, aid_out, amount_in, amount_out, block_ts);

-- ---------------------------------------------------------------------------
-- lp_events
-- ---------------------------------------------------------------------------

DELETE FROM lp_events a
USING lp_events b
WHERE a.event_id > b.event_id
  AND a.pool_id    = b.pool_id
  AND a.height     = b.height
  AND a.block_ts   = b.block_ts
  AND a.kind       = b.kind
  AND a.amount1    = b.amount1
  AND a.amount2    = b.amount2
  AND a.amount_ctl = b.amount_ctl;

CREATE UNIQUE INDEX IF NOT EXISTS lp_events_natural_key_idx
  ON lp_events (pool_id, height, kind, amount1, amount2, amount_ctl, block_ts);

-- ---------------------------------------------------------------------------
-- Continuous aggregates were built from inflated data — force a full refresh
-- on the next indexer startup by zeroing the marker. catchUpAggregatesIfNeeded
-- detects marker < last_indexed_height and re-materializes everything.
-- ---------------------------------------------------------------------------

UPDATE cursor SET aggregates_refreshed_at_height = 0 WHERE id = 1;
