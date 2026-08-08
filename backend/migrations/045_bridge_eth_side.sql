-- Ethereum side of the bridge monitor.
--
-- Two separate Ethereum cursors per bridge, because the two scans have
-- different sources and different costs:
--   eth_scanned_to_block    NewLocalMessage log sweep (keyless RPC, windowed)
--   eth_tx_scanned_to_block processRemoteMessage tx scan (Etherscan, keyed)
-- Keeping them apart means an absent Etherscan key can't stall the log ingest,
-- and a log backfill can't make the settlement scan re-walk history.
ALTER TABLE bridge_cursors
  ADD COLUMN IF NOT EXISTS eth_tx_scanned_to_block BIGINT NOT NULL DEFAULT 0;

-- Latest observed collateral behind each bridge. One row per bridge, rewritten
-- in place — this is a "current value" gauge, not a time series. Compared
-- against the Beam-side minted supply to show whether the peg is fully backed.
--
-- `locked` is in the Ethereum asset's own units (USDT 6, DAI 18, WBTC 8,
-- ETH 18, WBEAM 8), which are NOT the Beam side's units. Store raw and scale
-- at the edge; `decimals` records which is which.
CREATE TABLE IF NOT EXISTS bridge_escrow (
  bridge       TEXT PRIMARY KEY,
  chain_id     INTEGER     NOT NULL,
  token        TEXT,                    -- NULL when the Pipe escrows native ETH
  locked       NUMERIC(40, 0) NOT NULL,
  decimals     INTEGER     NOT NULL,
  block_number BIGINT,
  observed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ethereum-side provenance for eth2beam rows. The Beam side can't supply these:
-- ReceiveFunds deletes the message header on claim (pipe_contract.cpp Method_4),
-- so a completed message reports "absent" and its amount is only recoverable
-- from the NewLocalMessage log.
ALTER TABLE bridge_messages
  ADD COLUMN IF NOT EXISTS src_tx TEXT;
