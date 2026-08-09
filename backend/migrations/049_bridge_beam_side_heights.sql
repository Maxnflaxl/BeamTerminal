-- Beam-side heights for incoming (eth2beam) transfers.
--
-- `msg_status` is a tri-state (0 never delivered / 1 claimed / 2 delivered and
-- unclaimed) and carries no height or timestamp, so an incoming transfer had
-- nothing to show on the Beam side at all — not when the relayer delivered it,
-- not when the recipient claimed it.
--
-- Both are recoverable from the Pipe's own call history, which we already fetch
-- for src_call_height. On the four b-asset Pipes (shader SID 38f8c1d4…) the
-- explorer exposes each call's raw arguments, and the message id is the leading
-- little-endian uint64 of two of them:
--
--   method 5  PushRemote   msgId + 33-byte recipient pubkey + amount + fee
--             -> the block the relayer delivered the message in
--   method 4  ReceiveFunds msgId (8 bytes, nothing else)
--             -> the block the recipient claimed it in
--
-- The BEAM/WBEAM Pipes are upgradable2-wrapped: the explorer decodes their
-- calls as "Passthrough" and drops the inner arguments, so their messages keep
-- both columns NULL until the parser is extended.
--
-- Timestamps are deliberately not stored — block_metrics covers every height,
-- so the API joins for them and a reorg can't leave a stale copy behind.
ALTER TABLE bridge_messages
  ADD COLUMN IF NOT EXISTS delivered_height BIGINT,
  ADD COLUMN IF NOT EXISTS claimed_height   BIGINT;
