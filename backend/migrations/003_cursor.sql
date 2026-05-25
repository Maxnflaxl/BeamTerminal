-- Single-row state table for the indexer.
CREATE TABLE cursor (
  id                   INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_indexed_height  BIGINT NOT NULL DEFAULT 0,
  last_indexed_hash    BYTEA,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO cursor (id, last_indexed_height) VALUES (1, 0);
