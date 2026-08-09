-- Pipe message amounts are uint256 on the Ethereum side, and some messages
-- really do carry values near 2^256 — 78 digits, which NUMERIC(40,0) rejects
-- with "numeric field overflow", aborting the whole log ingest for that bridge.
--
-- These are spam pushed into the Pipe rather than real transfers: bDAI msgIds
-- 43-48, bUSDT 128/136 and bWBTC 22 all carry ~2^256 amounts or relayer fees,
-- and they are precisely the messages the relayer never delivered to Beam. The
-- monitor still has to record them — "the relayer refused this" is exactly the
-- kind of thing the page exists to show — so the column has to fit uint256.
--
-- uint256 max is 78 digits; 80 leaves headroom.
ALTER TABLE bridge_messages
  ALTER COLUMN amount      TYPE NUMERIC(80, 0),
  ALTER COLUMN relayer_fee TYPE NUMERIC(80, 0);

ALTER TABLE bridge_escrow
  ALTER COLUMN locked TYPE NUMERIC(80, 0),
  ALTER COLUMN minted TYPE NUMERIC(80, 0);
