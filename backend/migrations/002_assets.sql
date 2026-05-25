CREATE TABLE assets (
  aid                BIGINT PRIMARY KEY,
  name               TEXT,
  short_name         TEXT,
  unit_name          TEXT,
  description        TEXT,
  decimals           SMALLINT NOT NULL DEFAULT 8,
  is_imposter        BOOLEAN NOT NULL DEFAULT FALSE,
  imposter_reason    TEXT,
  emission           NUMERIC(40, 0),
  first_seen_height  BIGINT,
  last_updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX assets_short_name_lower_idx ON assets (lower(short_name));

-- Seed BEAM (aid 0). Native chain asset; metadata is implicit.
INSERT INTO assets (aid, name, short_name, unit_name, description, decimals)
VALUES (0, 'Beam', 'BEAM', 'BEAM', 'Native BEAM asset', 8);
