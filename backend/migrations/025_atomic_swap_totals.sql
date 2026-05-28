-- Snapshots of the explorer's `/swap_totals` aggregate. One row per indexer
-- tick that successfully reads the endpoint. TimescaleDB hypertable so we
-- can render "BEAM offered cross-chain over time" without table-scanning
-- billions of rows once this thing has been running for a while.
--
-- All amounts are decimal strings on the wire — keep them as text and parse
-- on display. We don't know the canonical unit per-currency (e.g. satoshis
-- vs BTC) without referencing wallet/transactions/swaps/common.cpp; storing
-- text leaves that decision to the renderer.
CREATE TABLE IF NOT EXISTS atomic_swap_totals_snapshots (
  ts                   TIMESTAMPTZ PRIMARY KEY,
  height               BIGINT,
  total_swaps_count    INTEGER,
  beams_offered        TEXT,
  bitcoin_offered      TEXT,
  litecoin_offered     TEXT,
  qtum_offered         TEXT,
  dogecoin_offered     TEXT,
  dash_offered         TEXT,
  ethereum_offered     TEXT,
  dai_offered          TEXT,
  usdt_offered         TEXT,
  wbtc_offered         TEXT
);

SELECT create_hypertable(
  'atomic_swap_totals_snapshots',
  'ts',
  if_not_exists => TRUE,
  migrate_data  => TRUE
);
