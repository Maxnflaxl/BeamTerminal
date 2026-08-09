-- The Pipe contract records Env::get_Height() with each outgoing message — the
-- height of the last block known when the transaction was built. The call then
-- lands in a *later* block, in practice the next one: across 309 indexed
-- messages, 308 matched the contract's call history at height+1 and the one
-- exception was a coincidental second call at the same height.
--
-- The consequence was user-visible: looking up a transfer's reported height in
-- the explorer showed no contract activity at all, because the call is one
-- block further on.
--
-- src_height keeps the contract's own value (it's what the shader says).
-- src_call_height is the block that actually contains the call, resolved
-- against the Pipe's call history rather than assumed to be +1 — the offset
-- isn't guaranteed by anything, it just happens to be 1 every time so far.
ALTER TABLE bridge_messages
  ADD COLUMN IF NOT EXISTS src_call_height BIGINT;

CREATE INDEX IF NOT EXISTS bridge_messages_call_height_idx
  ON bridge_messages (src_call_height)
  WHERE src_call_height IS NOT NULL;
