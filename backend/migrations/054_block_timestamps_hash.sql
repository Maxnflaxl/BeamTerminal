-- Store each cached block's hash next to its timestamp so reorg recovery can
-- compare what we indexed at height H against what the chain reports at H now.
-- Without a per-height hash the ancestor search has nothing to compare: the
-- explorer serves the active chain's block for every height, so `found: true`
-- says nothing about whether *our* view of H is still canonical.
--
-- Nullable: rows written before this column existed carry no hash. The
-- ancestor search treats such heights as unverifiable and accepts them as
-- on-chain, matching the behaviour before hashes were recorded.
ALTER TABLE block_timestamps ADD COLUMN IF NOT EXISTS hash BYTEA;
