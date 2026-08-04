-- The pin worker retried every unpinned CID on every tick, with no memory of
-- how often it had already failed. A CID nobody on the swarm serves therefore
-- burned PIN_TIMEOUT_MS per row per tick, forever — one tombstoned dapp kept
-- the indexer busy for two minutes out of every tick for weeks.
--
-- Track attempts so the worker can back off exponentially and still converge
-- on a CID that only becomes available later (publisher comes back online).

ALTER TABLE dapps
  ADD COLUMN IF NOT EXISTS ipfs_pin_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ipfs_pin_last_attempt_at TIMESTAMPTZ;

ALTER TABLE dapp_versions
  ADD COLUMN IF NOT EXISTS ipfs_pin_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ipfs_pin_last_attempt_at TIMESTAMPTZ;
