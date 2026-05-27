-- Asset brand colour from the OPT_COLOR metadata key. Used to tint asset icons
-- and shown on the asset detail page. Populated by syncAssetsCatalog; null when
-- the asset's metadata doesn't define OPT_COLOR.
ALTER TABLE assets ADD COLUMN IF NOT EXISTS color TEXT;
