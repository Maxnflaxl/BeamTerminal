-- Per-message state for the Beam <-> Ethereum Pipe bridges.
--
-- Five live bridges (four b-asset Pipes sharing shader SID 38f8c1d4…, plus the
-- upgradable2-wrapped BEAM/WBEAM Pipe). Volume is tiny — 730 Beam->ETH messages
-- across all bridges since 2022 — so this is a plain table, not a hypertable:
-- it's queried by status and recency, never time-bucketed.
--
-- Status vocabularies differ per direction because the underlying contract
-- states differ (see pipe_contract.cpp Method_4/Method_5):
--
--   beam2eth  pending        message exists on Beam, no settling ETH tx seen yet
--             relayed        processRemoteMessage succeeded on Ethereum
--             failed         processRemoteMessage reverted (and never succeeded)
--             unknown        we could not read the Ethereum side
--
--   eth2beam  not_delivered  msg_status 0 — relayer never pushed it to Beam
--             unclaimed      msg_status 2 — funds minted on Beam, awaiting the
--                            recipient's ReceiveFunds signature. NOT an error:
--                            only the owner can claim, and some sit for years.
--             complete       msg_status 1 — recipient claimed
--             unknown        we could not read the Beam side
--
-- `unknown` exists so a wallet-api or Etherscan failure never masquerades as a
-- definite state. Never collapse it into not_delivered/pending.
CREATE TABLE IF NOT EXISTS bridge_messages (
  bridge        TEXT        NOT NULL,
  chain_id      INTEGER     NOT NULL,
  direction     TEXT        NOT NULL CHECK (direction IN ('beam2eth', 'eth2beam')),
  msg_id        BIGINT      NOT NULL,
  status        TEXT        NOT NULL,
  amount        NUMERIC(40, 0),
  relayer_fee   NUMERIC(40, 0),
  -- beam2eth: 20-byte Ethereum address. eth2beam: 33-byte Beam pubkey. Hex, no 0x.
  receiver      TEXT,
  -- Origin: Beam height for beam2eth, Ethereum block for eth2beam.
  src_height    BIGINT,
  src_block     BIGINT,
  src_ts        TIMESTAMPTZ,
  -- Settlement on the far side (beam2eth only — the Beam side has no tx hash).
  settle_tx     TEXT,
  settle_block  BIGINT,
  settle_ts     TIMESTAMPTZ,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (bridge, chain_id, direction, msg_id)
);

-- Health queries ("what is outstanding, oldest first") hit only the unsettled
-- rows, which are a tiny minority. Partial index keeps it that way.
CREATE INDEX IF NOT EXISTS bridge_messages_open_idx
  ON bridge_messages (bridge, direction, src_ts)
  WHERE status IN ('pending', 'not_delivered', 'unclaimed', 'unknown');

CREATE INDEX IF NOT EXISTS bridge_messages_recent_idx
  ON bridge_messages (src_ts DESC);

-- Per-bridge high-water marks so a restart never re-walks history. beam_msg_hi
-- is the highest Beam-side local msg_id ingested; eth_scanned_to_block is where
-- the Ethereum log/tx scan left off. Both advance monotonically.
CREATE TABLE IF NOT EXISTS bridge_cursors (
  bridge              TEXT PRIMARY KEY,
  chain_id            INTEGER NOT NULL,
  beam_msg_hi         BIGINT  NOT NULL DEFAULT 0,
  eth_scanned_to_block BIGINT NOT NULL DEFAULT 0,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
