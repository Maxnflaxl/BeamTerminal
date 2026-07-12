import { config } from '../config.js';
import { q } from '../db.js';
import { getContract } from '../explorer.js';
import { getBlockTsMap } from './blockTimestamps.js';
import { logger } from '../logger.js';

// Projects DaoVote data into the dao_* tables each tick:
//  - contract state (getContract) -> per-proposal tallies + per-epoch turnout
//  - AddProposal calls -> proposal text/moderator (Nth call = proposal N, since
//    the contract assigns ++m_iLastProposal in call order)
// Runs off the explorer (like BANS), so it needs no wallet-api.

function cellNum(c: unknown): number | null {
  if (typeof c === 'number') return c;
  if (c && typeof c === 'object' && 'value' in c) {
    const n = Number(String((c as { value: unknown }).value).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(c);
  return Number.isFinite(n) ? n : null;
}

/** Raw groth integer from an `{type:'amount', value}` cell (no exp_am formatting). */
function amountGroth(c: unknown): string {
  const raw = c && typeof c === 'object' && 'value' in c ? (c as { value: unknown }).value : c;
  return (String(raw).replace(/,/g, '').split('.')[0] || '0');
}

/** "0a1fff" | {value:"0a1fff"} -> [10, 31, 255]. Tolerates a 0x prefix. */
function choiceBytes(cell: unknown): number[] {
  const raw = cell && typeof cell === 'object' && 'value' in cell ? (cell as { value: unknown }).value : cell;
  const hex = String(raw ?? '').trim().replace(/^0x/i, '');
  const out: number[] = [];
  for (let i = 0; i + 1 < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

function stateTableRows(state: Record<string, unknown>, key: string): unknown[] {
  const tbl = state[key] as { value?: unknown[] } | undefined;
  return Array.isArray(tbl?.value) ? tbl!.value!.slice(1) : []; // drop header row
}

/** Snapshot per-proposal variant tallies + per-epoch turnout from already-fetched
 *  decoded contract state (see projectDaoVote — state is fetched once per tick). */
export async function snapshotDaoVoteState(state: Record<string, unknown>, h: number): Promise<void> {
  // The full state table is re-projected every tick, so both upserts are
  // batched (one statement per table) and guarded with IS DISTINCT FROM on
  // the data columns — otherwise every row would be rewritten every 30s,
  // churning dead tuples forever. snapshot_height therefore records the
  // height at which the value last CHANGED, not the last tick.
  // Deduped by key, last occurrence wins — a multi-row upsert may not touch
  // the same row twice.
  const proposals = new Map<number, { epoch: number; variantCount: number }>();
  const tallies = new Map<string, { id: number; v: number; stake: string }>();

  for (const row of stateTableRows(state, 'Proposals')) {
    if (!Array.isArray(row)) continue;
    const id = cellNum(row[0]);
    const epoch = cellNum(row[1]);
    // Variants arrive either as an amount array or, for binary proposals, a
    // labelled {No, Yes} object — take the values in order (index = variant).
    const vcell = row[2];
    const variants = Array.isArray(vcell)
      ? vcell
      : vcell && typeof vcell === 'object'
        ? Object.values(vcell as Record<string, unknown>)
        : [];
    if (id == null || epoch == null) continue;
    proposals.set(id, { epoch, variantCount: variants.length });
    for (let v = 0; v < variants.length; v++) {
      tallies.set(`${id}:${v}`, { id, v, stake: amountGroth(variants[v]) });
    }
  }

  if (proposals.size > 0) {
    const rows = [...proposals.entries()];
    await q(
      `INSERT INTO dao_proposals (proposal_id, epoch, height, block_ts, variant_count)
       SELECT t.id, t.epoch, 0, now(), t.variant_count
         FROM unnest($1::bigint[], $2::int[], $3::int[]) AS t(id, epoch, variant_count)
       ON CONFLICT (proposal_id) DO UPDATE SET epoch = EXCLUDED.epoch, variant_count = EXCLUDED.variant_count
        WHERE (dao_proposals.epoch, dao_proposals.variant_count)
              IS DISTINCT FROM (EXCLUDED.epoch, EXCLUDED.variant_count)`,
      [rows.map(([id]) => id), rows.map(([, r]) => r.epoch), rows.map(([, r]) => r.variantCount)],
    );
  }
  if (tallies.size > 0) {
    const rows = [...tallies.values()];
    await q(
      `INSERT INTO dao_proposal_tallies (proposal_id, variant, stake_groth, snapshot_height)
       SELECT t.id, t.v, t.stake, $4
         FROM unnest($1::bigint[], $2::int[], $3::numeric[]) AS t(id, v, stake)
       ON CONFLICT (proposal_id, variant) DO UPDATE SET stake_groth = EXCLUDED.stake_groth, snapshot_height = EXCLUDED.snapshot_height
        WHERE dao_proposal_tallies.stake_groth IS DISTINCT FROM EXCLUDED.stake_groth`,
      [rows.map((r) => r.id), rows.map((r) => r.v), rows.map((r) => r.stake), h],
    );
  }

  const epochs = new Map<number, { active: string; voted: string }>();
  for (const row of stateTableRows(state, 'Epoch stats')) {
    if (!Array.isArray(row)) continue;
    const epoch = cellNum(row[0]);
    if (epoch == null) continue;
    epochs.set(epoch, { active: amountGroth(row[1]), voted: amountGroth(row[2]) });
  }
  if (epochs.size > 0) {
    const rows = [...epochs.entries()];
    await q(
      `INSERT INTO dao_epoch_stats (epoch, stake_active, stake_voted, snapshot_height, block_ts)
       SELECT t.epoch, t.active, t.voted, $4, now()
         FROM unnest($1::bigint[], $2::numeric[], $3::numeric[]) AS t(epoch, active, voted)
       ON CONFLICT (epoch) DO UPDATE SET stake_active = EXCLUDED.stake_active, stake_voted = EXCLUDED.stake_voted, snapshot_height = EXCLUDED.snapshot_height
        WHERE (dao_epoch_stats.stake_active, dao_epoch_stats.stake_voted)
              IS DISTINCT FROM (EXCLUDED.stake_active, EXCLUDED.stake_voted)`,
      [rows.map(([e]) => e), rows.map(([, r]) => r.active), rows.map(([, r]) => r.voted), h],
    );
  }
}

/** Enrich dao_proposals with text/moderator/height from the AddProposal calls. */
export async function projectDaoProposalTexts(): Promise<void> {
  const cid = config.DAO_VOTE_CID;
  if (!cid) return;
  const { rows } = await q<{ height: string; block_ts: Date; args: Record<string, unknown> | null }>(
    `SELECT height, block_ts, args FROM contract_call_events
      WHERE cid = $1 AND method = 'Add proposal' AND parent_ord IS NULL
      ORDER BY height ASC, ord ASC`,
    [cid],
  );
  if (rows.length === 0) return;
  // One statement for all proposals, updating only rows whose enrichment
  // actually changed — the call list is re-read every tick, and unconditional
  // per-row UPDATEs would rewrite every proposal every 30s.
  await q(
    `UPDATE dao_proposals dp
        SET text = u.text, moderator_pk = u.moderator, height = u.height, block_ts = u.block_ts
       FROM unnest($1::bigint[], $2::text[], $3::text[], $4::bigint[], $5::timestamptz[])
              AS u(id, text, moderator, height, block_ts)
      WHERE dp.proposal_id = u.id
        AND (dp.text, dp.moderator_pk, dp.height, dp.block_ts)
            IS DISTINCT FROM (u.text, u.moderator, u.height, u.block_ts)`,
    [
      rows.map((_, i) => i + 1), // Nth AddProposal call -> proposal id N
      rows.map((r) => (r.args?.text != null ? String(r.args.text) : null)),
      rows.map((r) => (r.args?.moderator != null ? String(r.args.moderator) : null)),
      rows.map((r) => Number(r.height)),
      rows.map((r) => r.block_ts),
    ],
  );
}

/** Ingest individual votes (with exact stake-weight) from the decoded
 *  "User votes" log table of already-fetched contract state. Each UserVote
 *  event carries the voter's stake and their per-proposal choices for one
 *  epoch. `Proposal0` is the id of the last proposal of the PREVIOUS epoch, so
 *  the event's choices[i] maps to global proposal id `Proposal0 + 1 + i` — an
 *  epoch's proposals are the contiguous range [Proposal0+1 .. Proposal0+N].
 *  Idempotent (PK proposal_id, voter_pk, height). */
export async function projectDaoVotes(state: Record<string, unknown>): Promise<void> {
  const rows = stateTableRows(state, 'User votes').filter(Array.isArray) as unknown[][];
  if (rows.length === 0) return;

  // Votes reference proposals by global id; only ingest ones we've snapshotted.
  // A choice for a proposal not yet in dao_proposals — or a trailing padding
  // choice past the epoch's real proposals — is skipped and picked up later.
  const { rows: propRows } = await q<{ proposal_id: string }>('SELECT proposal_id FROM dao_proposals');
  const knownProposalIds = new Set(propRows.map((r) => Number(r.proposal_id)));

  const heights = [...new Set(rows.map((row) => cellNum(row[0])).filter((h): h is number => h != null))];
  const tsMap = await getBlockTsMap(heights);

  // Collect every mappable vote-choice, deduped by the (proposal_id, voter_pk,
  // height) PK with the last occurrence winning — matching the sequential
  // upsert's last-write-wins, and required because a multi-row upsert may not
  // touch the same row twice.
  const votes = new Map<string, {
    proposalId: number; voter: string; variant: number; stake: string; height: number; ts: Date;
  }>();

  for (const row of rows) {
    const height = cellNum(row[0]);
    const voter = row[1] && typeof row[1] === 'object' && 'value' in row[1]
      ? String((row[1] as { value: unknown }).value)
      : row[1] != null ? String(row[1]) : null;
    const proposal0 = cellNum(row[2]);
    const stake = amountGroth(row[3]);
    if (height == null || !voter || proposal0 == null) continue;
    const ts = tsMap.get(height);
    if (ts == null) continue;                 // block ts not resolvable yet — next tick

    const bytes = choiceBytes(row[4]);
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] === 0xff) continue;        // s_NoVote
      const proposalId = proposal0 + 1 + i;   // epoch proposals are [Proposal0+1 .. Proposal0+N]
      if (!knownProposalIds.has(proposalId)) continue; // not snapshotted yet / padding past the epoch
      votes.set(`${proposalId}:${voter}:${height}`, {
        proposalId, voter, variant: bytes[i]!, stake, height, ts,
      });
    }
  }

  if (votes.size > 0) {
    // One multi-row upsert for the whole cumulative vote log, only rewriting
    // rows whose data actually changed (this runs every tick).
    const v = [...votes.values()];
    await q(
      `INSERT INTO dao_votes (proposal_id, voter_pk, variant, weight_groth, height, block_ts)
       SELECT t.proposal_id, t.voter_pk, t.variant, t.weight_groth, t.height, t.block_ts
         FROM unnest($1::bigint[], $2::text[], $3::int[], $4::numeric[], $5::bigint[], $6::timestamptz[])
                AS t(proposal_id, voter_pk, variant, weight_groth, height, block_ts)
       ON CONFLICT (proposal_id, voter_pk, height)
       DO UPDATE SET variant = EXCLUDED.variant, weight_groth = EXCLUDED.weight_groth, block_ts = EXCLUDED.block_ts
        WHERE (dao_votes.variant, dao_votes.weight_groth, dao_votes.block_ts)
              IS DISTINCT FROM (EXCLUDED.variant, EXCLUDED.weight_groth, EXCLUDED.block_ts)`,
      [
        v.map((x) => x.proposalId),
        v.map((x) => x.voter),
        v.map((x) => x.variant),
        v.map((x) => x.stake),
        v.map((x) => x.height),
        v.map((x) => x.ts),
      ],
    );
  }

  // If the Proposal0 -> id mapping ever drifts, every vote silently vanishes via
  // the `continue`s above. Surface that specifically (rows present, none mapped).
  if (rows.length > 0 && votes.size === 0) {
    logger.warn(
      { rows: rows.length },
      'dao-vote: User votes rows present but none mapped to a proposal (Proposal0 mapping?)',
    );
  }
}

/** One tick of the DaoVote projection: fetch contract state once, then state
 *  snapshot, proposal-text enrichment, and individual vote ingest (both of
 *  which reuse the same fetch rather than re-querying the explorer). */
export async function projectDaoVote(): Promise<void> {
  const cid = config.DAO_VOTE_CID;
  if (!cid) return;
  const resp = await getContract({ id: cid, state: true, nMaxTxs: 0 });
  const state = resp.State ?? {};
  const h = resp.h ?? 0;
  await snapshotDaoVoteState(state, h);
  await projectDaoProposalTexts();
  await projectDaoVotes(state);
}
