-- Capture the DaoVault fee skim per trade (groths in `aid_in`). Nullable
-- because legacy rows pre-date this column; a one-off script backfills it
-- from the explorer's Calls history (nested DaoVault Deposit amount).
ALTER TABLE trades ADD COLUMN IF NOT EXISTS fee_groth NUMERIC(40, 0);
