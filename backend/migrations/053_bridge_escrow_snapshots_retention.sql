-- bridge_escrow_snapshots grows forever otherwise: the bridge sync appends one
-- row per bridge per cycle, and nothing ever deletes them. The VPS root disk is
-- shared with the ~48 GB mainnet explorer-node database and runs with under 2 GB
-- free, where an unbounded hypertable ends as a Postgres checkpoint PANIC and a
-- crash loop, not as a slow query.
--
-- Two years is well past the point where a snapshot still earns its keep: the
-- reconstruction in services/bridgeTvl.ts anchors on the *latest* snapshot and
-- walks message flow backwards from it, so older rows only ever serve as a
-- cross-check on history the flow already explains.
SELECT add_retention_policy('bridge_escrow_snapshots', INTERVAL '2 years',
                            if_not_exists => TRUE);
