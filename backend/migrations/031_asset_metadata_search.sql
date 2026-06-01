-- Persist the asset's project URL (OPT_SITE_URL) and long description
-- (OPT_LONG_DESC) so the magic-search can match asset metadata, not just the
-- short description. The asset catalog resync (every ~10 min) backfills rows.
ALTER TABLE assets ADD COLUMN IF NOT EXISTS website          TEXT;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS long_description TEXT;
