-- Governance projection from DaoVote, decoded by the extended explorer parser.
-- Proposals + tallies + turnout + individual votes are snapshotted from the
-- decoded contract state each tick (current epoch overwritten, past epochs
-- immutable); proposal text is enriched from AddProposal calls in
-- contract_call_events.

CREATE TABLE IF NOT EXISTS dao_proposals (
  proposal_id   BIGINT PRIMARY KEY,
  epoch         INTEGER     NOT NULL,
  height        BIGINT      NOT NULL,
  block_ts      TIMESTAMPTZ NOT NULL,
  variant_count INTEGER     NOT NULL,
  text          TEXT,
  moderator_pk  TEXT
);
CREATE INDEX IF NOT EXISTS dao_proposals_epoch_idx ON dao_proposals (epoch, proposal_id);

-- One row per (proposal, voter): the variant that voter chose for that proposal.
CREATE TABLE IF NOT EXISTS dao_votes (
  proposal_id  BIGINT      NOT NULL,
  voter_pk     TEXT        NOT NULL,
  variant      INTEGER     NOT NULL,       -- chosen variant index (255 = no-vote, filtered out)
  weight_groth NUMERIC(40, 0),             -- voter stake at vote time; null until backfilled
  height       BIGINT      NOT NULL,
  block_ts     TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (proposal_id, voter_pk, height)
);
CREATE INDEX IF NOT EXISTS dao_votes_proposal_idx ON dao_votes (proposal_id, weight_groth DESC);

-- Per-epoch turnout snapshot.
CREATE TABLE IF NOT EXISTS dao_epoch_stats (
  epoch           INTEGER     PRIMARY KEY,
  stake_active    NUMERIC(40, 0) NOT NULL,
  stake_voted     NUMERIC(40, 0) NOT NULL,
  snapshot_height BIGINT      NOT NULL,
  block_ts        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-proposal variant tallies (stake per variant).
CREATE TABLE IF NOT EXISTS dao_proposal_tallies (
  proposal_id     BIGINT  NOT NULL,
  variant         INTEGER NOT NULL,
  stake_groth     NUMERIC(40, 0) NOT NULL,
  snapshot_height BIGINT  NOT NULL,
  PRIMARY KEY (proposal_id, variant)
);
