-- Asset logo URL from the OPT_LOGO_URL metadata key (SVG vector logo per the
-- Asset Descriptor v1.0 spec). Rendered as the asset icon on the asset detail
-- page when present. Populated by syncAssetsCatalog; null when the asset's
-- metadata doesn't define OPT_LOGO_URL.
ALTER TABLE assets ADD COLUMN IF NOT EXISTS logo_url TEXT;
