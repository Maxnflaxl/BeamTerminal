-- DEX-style asset-to-asset swap offers. These are *not* on-chain state — they
-- are wallet-gossiped orders for the BVM DEX (different from atomic swaps,
-- which are cross-chain). Source: the BEAM wallet-api JSON-RPC method
-- `assets_swap_offers_list` (v7.2+, requires BEAM_ASSET_SWAP_SUPPORT build).
--
-- Offers come and go: an order shows up in the list while it's open, then
-- vanishes when it's filled, cancelled, or expires. The indexer doesn't know
-- which terminal state was reached — only that the offer is no longer being
-- broadcast. We capture that by writing `gone_at` the first tick an offer
-- stops appearing.
--
-- Not a hypertable: cardinality is small (open orders only), and we want
-- cheap upserts on a known primary key.
CREATE TABLE IF NOT EXISTS asset_swap_offers (
  id                  TEXT          PRIMARY KEY,
  is_my               BOOLEAN       NOT NULL DEFAULT FALSE,
  send_asset_id       INTEGER       NOT NULL,
  send_amount         NUMERIC(40,0) NOT NULL,
  send_currency_name  TEXT,
  receive_asset_id    INTEGER       NOT NULL,
  receive_amount      NUMERIC(40,0) NOT NULL,
  receive_currency_name TEXT,
  -- Unix seconds from the wallet-api response (`create_time` / `expire_time`).
  create_time         TIMESTAMPTZ   NOT NULL,
  expire_time         TIMESTAMPTZ   NOT NULL,
  -- First time we saw this offer in the gossiped list.
  first_seen_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
  -- Last tick we still saw it. Becomes "the moment before it disappeared"
  -- once the offer drops off.
  last_seen_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  -- NULL → still open. Set the tick the offer first failed to appear.
  gone_at             TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS asset_swap_offers_open_idx
  ON asset_swap_offers (expire_time DESC)
  WHERE gone_at IS NULL;

CREATE INDEX IF NOT EXISTS asset_swap_offers_send_asset_idx
  ON asset_swap_offers (send_asset_id, gone_at);

CREATE INDEX IF NOT EXISTS asset_swap_offers_receive_asset_idx
  ON asset_swap_offers (receive_asset_id, gone_at);
