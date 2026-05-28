-- Cross-chain atomic swap offers (BEAM ↔ BTC/LTC/QTUM/DOGE/DASH/ETH/DAI/USDT/WBTC).
-- Source: explorer `GET /swap_offers` (only when the node was built with
-- `BEAM_ATOMIC_SWAP_SUPPORT`).
--
-- Like asset_swap_offers, this is gossip — offers appear in the list while
-- open and vanish on fill/cancel/expiry. Same lifecycle modelling: `seen_at`,
-- `gone_at`.
--
-- `swap_currency` is a build-dependent integer enum in the wire format. We
-- store both the raw integer and a resolved label (NULL when the mapping is
-- unknown to the indexer build). Mapping table lives in code:
-- backend/src/services/atomicSwaps.ts::SWAP_CURRENCY_NAMES.
CREATE TABLE IF NOT EXISTS atomic_swap_offers (
  -- The explorer returns a `txId` (32-hex-char swap-tx identifier). Two
  -- distinct offers may legitimately share the same txId across is_beam_side
  -- variants, so the natural key includes side too.
  tx_id           TEXT          NOT NULL,
  is_beam_side    BOOLEAN       NOT NULL,
  status          SMALLINT      NOT NULL,
  status_string   TEXT,
  beam_amount     NUMERIC(40,0) NOT NULL,
  swap_amount     NUMERIC(40,0) NOT NULL,
  swap_currency   SMALLINT      NOT NULL,
  swap_currency_name TEXT,
  time_created    TIMESTAMPTZ   NOT NULL,
  min_height      BIGINT,
  height_expired  BIGINT,
  first_seen_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
  gone_at         TIMESTAMPTZ,
  PRIMARY KEY (tx_id, is_beam_side)
);

CREATE INDEX IF NOT EXISTS atomic_swap_offers_open_idx
  ON atomic_swap_offers (time_created DESC)
  WHERE gone_at IS NULL;

CREATE INDEX IF NOT EXISTS atomic_swap_offers_currency_idx
  ON atomic_swap_offers (swap_currency, gone_at);
