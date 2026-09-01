-- Pipe message amounts are uint256 on the Ethereum side, and some messages
-- really do carry values near 2^256 — 78 digits, which NUMERIC(40,0) rejects
-- with "numeric field overflow", aborting the whole log ingest for that bridge.
--
-- These are attempts on the bridge rather than real transfers. The Ethereum
-- Pipe (solidity ^0.7.2) computes `total = amount + relayerFee` with unchecked
-- arithmetic, so a large enough pair wraps `total` back down to a trivial sum:
-- the sender claims an enormous amount while paying almost nothing. bDAI msgIds
-- 43-48, bUSDT 128/136 and bWBTC 22 all push one term to ~2^256 — sometimes the
-- amount, sometimes the relayer fee, since wrapping the sum is what matters —
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
