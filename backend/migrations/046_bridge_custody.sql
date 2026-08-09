-- Custody direction differs between the bridges, and the original escrow model
-- assumed only one of them.
--
--   b-asset bridges (bETH/bUSDT/bWBTC/bDAI): collateral is locked on **Ethereum**
--     and the wrapped asset is minted on Beam. `locked` = ERC20/ETH balance of
--     the Ethereum Pipe, `minted` = the Beam asset's emission.
--
--   BEAM/WBEAM: the reverse. Collateral (native BEAM, aid 0) is locked in the
--     **Beam** Pipe contract and WBEAM is minted on Ethereum. Reading the
--     Ethereum Pipe's balance returns 0 there — it mints, it doesn't escrow —
--     and the Beam-side "minted" figure would be BEAM's entire emission, which
--     has nothing to do with the bridge.
--
-- So the minted side is recorded explicitly for bridges whose collateral sits on
-- Beam; the others keep deriving it from assets.emission.
ALTER TABLE bridge_escrow
  ADD COLUMN IF NOT EXISTS minted          NUMERIC(40, 0),
  ADD COLUMN IF NOT EXISTS minted_decimals INTEGER;
