-- Until now the DApp Store upsert overwrote `ipfs_id` / `ipfs_hash` on a new
-- release but left `ipfs_pinned_at` set, so the pin worker skipped the new
-- CID and our node never mirrored it. Those bundles are downloadable only
-- while the publisher's own node is online; once it goes away, /api/dapp/:cid
-- times out with nothing on the swarm to serve the blocks.
--
-- The upsert now clears the flag whenever the CID changes. Re-arm the rows
-- that already went stale: a dapp updated after we pinned it is exactly the
-- suspect set. The pin worker picks them up on its next tick and re-fetches;
-- a CID that is still in the local repo re-pins immediately.

UPDATE dapps
   SET ipfs_pinned_at = NULL
 WHERE ipfs_pinned_at IS NOT NULL
   AND ipfs_id IS NOT NULL
   AND deleted_at IS NULL
   AND last_updated_at > ipfs_pinned_at;

-- dapp_versions carries no timestamp of its own for the (dapp_id, 0, 2)
-- projection sentinel — the row is rewritten in place on every release. Tie
-- it to the parent dapp's re-arm above.
UPDATE dapp_versions v
   SET ipfs_pinned_at = NULL
  FROM dapps d
 WHERE d.id = v.dapp_id
   AND v.ipfs_pinned_at IS NOT NULL
   AND v.ipfs_hash IS NOT NULL
   AND d.deleted_at IS NULL
   AND d.last_updated_at > v.ipfs_pinned_at;
