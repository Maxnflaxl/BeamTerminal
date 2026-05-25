-- Track which assets were minted via the Beam Asset Minter contract, and the
-- per-asset supply cap configured at creation. The Minter contract's
-- State.Tokens table exposes [Aid, Metadata, Owner, Minted, Limit]; we read
-- `Limit` once and store it here.
--
-- `max_supply IS NULL` means either: not minter-issued, or the minter's Limit
-- is UINT64_MAX (the contract's "unlimited" sentinel).
ALTER TABLE assets
  ADD COLUMN minter_cid  TEXT,
  ADD COLUMN max_supply  NUMERIC(40, 0);
