-- Record each asset's on-chain owner so the UI can label the issuer correctly.
-- The explorer's /assets table exposes an "Owner" column that is either a
-- wallet owner-key ({type:"blob"}) or a contract id ({type:"cid"}). We only
-- store the contract case: `owner_cid` is the issuing contract's CID, NULL for
-- wallet-issued assets (and aid 0 / BEAM).
--
-- `owner_kind` is the contract's human-readable parser name from the explorer's
-- /contracts table ("DEX v0", "Nephrite v1", "Minter", "DaoCore2 v0", …),
-- resolved at catalog-sync time. NULL when the owner CID isn't a known
-- deployed contract — the UI falls back to a generic "Contract" label then.
--
-- `owner_addr` is the wallet owner-key (the {type:"blob"} Owner value) for
-- wallet-issued assets, so the UI can show "Wallet (<key>)". NULL for
-- contract-issued assets (owner_cid is set instead) and aid 0 (BEAM).
ALTER TABLE assets
  ADD COLUMN owner_cid   TEXT,
  ADD COLUMN owner_kind  TEXT,
  ADD COLUMN owner_addr  TEXT;
