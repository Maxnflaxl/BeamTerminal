-- Drop NOT NULL on the date columns in dapps + dapp_publishers.
--
-- 026 declared these NOT NULL on the assumption that the projector would
-- always know the registration height. In practice the explorer can't decode
-- the upgradable2-wrapped DApp Store call args, which means:
--   - For a publisher with >1 current dapp, we cannot tell which add_dapp
--     call created which dapp (the publisher's blob is the only arg the
--     explorer surfaces). Per-dapp first_seen / last_updated is unrecoverable.
--   - For a publisher we've never observed in a call (extreme edge case —
--     should not happen on healthy chains), publisher-level dates are also
--     unknown.
--
-- We'd rather show "unknown" than a misleading sentinel, so allow NULL and
-- let the projector / API render it honestly. The publisher's date columns
-- become nullable too for symmetry with the rare zero-calls edge case.

ALTER TABLE dapps             ALTER COLUMN first_seen_height   DROP NOT NULL;
ALTER TABLE dapps             ALTER COLUMN first_seen_at       DROP NOT NULL;
ALTER TABLE dapps             ALTER COLUMN last_updated_height DROP NOT NULL;
ALTER TABLE dapps             ALTER COLUMN last_updated_at     DROP NOT NULL;

ALTER TABLE dapp_publishers   ALTER COLUMN first_seen_height   DROP NOT NULL;
ALTER TABLE dapp_publishers   ALTER COLUMN first_seen_at       DROP NOT NULL;
ALTER TABLE dapp_publishers   ALTER COLUMN last_updated_height DROP NOT NULL;
ALTER TABLE dapp_publishers   ALTER COLUMN last_updated_at     DROP NOT NULL;
