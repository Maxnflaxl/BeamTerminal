-- BeamTerminal's wallet-api node pins every dapp CID it learns about, so the
-- DApp Store catalog stays downloadable from gateway.beamterminal.0xmx.net
-- even when the original publisher's IPFS node goes offline. We track the
-- pin per-row in postgres so the indexer knows what's already done; pins
-- themselves are stored inside the wallet-api container's ipfs-repo.
--
-- Per-row, not per-CID: dapps and dapp_versions both carry IPFS refs (the
-- current one and the historical timeline). Each row pins independently;
-- if two rows happen to share a CID the duplicate pin call is a no-op on
-- the wallet-api side.

ALTER TABLE dapps
  ADD COLUMN IF NOT EXISTS ipfs_pinned_at TIMESTAMPTZ;

ALTER TABLE dapp_versions
  ADD COLUMN IF NOT EXISTS ipfs_pinned_at TIMESTAMPTZ;

-- Pin worker scans for IS NULL + IPFS-ref IS NOT NULL rows; a partial index
-- keeps the scan O(unpinned) instead of O(dapps).
CREATE INDEX IF NOT EXISTS dapps_unpinned_idx
  ON dapps (id)
  WHERE ipfs_pinned_at IS NULL AND ipfs_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS dapp_versions_unpinned_idx
  ON dapp_versions (dapp_id, height)
  WHERE ipfs_pinned_at IS NULL AND ipfs_hash IS NOT NULL;
