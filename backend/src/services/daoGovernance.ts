import { config } from '../config.js';
import { q } from '../db.js';
import { getContract } from '../explorer.js';
import { getBlockTsMap } from './blockTimestamps.js';

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

/** Snapshot per-proposal variant tallies + per-epoch turnout from decoded state. */
export async function snapshotDaoVoteState(): Promise<void> {
  const cid = config.DAO_VOTE_CID;
  if (!cid) return;
  const resp = await getContract({ id: cid, state: true, nMaxTxs: 0 });
  const state = resp.State ?? {};
  const h = resp.h ?? 0;

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
    await q(
      `INSERT INTO dao_proposals (proposal_id, epoch, height, block_ts, variant_count)
       VALUES ($1, $2, 0, now(), $3)
       ON CONFLICT (proposal_id) DO UPDATE SET epoch = EXCLUDED.epoch, variant_count = EXCLUDED.variant_count`,
      [id, epoch, variants.length],
    );
    for (let v = 0; v < variants.length; v++) {
      await q(
        `INSERT INTO dao_proposal_tallies (proposal_id, variant, stake_groth, snapshot_height)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (proposal_id, variant) DO UPDATE SET stake_groth = EXCLUDED.stake_groth, snapshot_height = EXCLUDED.snapshot_height`,
        [id, v, amountGroth(variants[v]), h],
      );
    }
  }

  for (const row of stateTableRows(state, 'Epoch stats')) {
    if (!Array.isArray(row)) continue;
    const epoch = cellNum(row[0]);
    if (epoch == null) continue;
    await q(
      `INSERT INTO dao_epoch_stats (epoch, stake_active, stake_voted, snapshot_height, block_ts)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (epoch) DO UPDATE SET stake_active = EXCLUDED.stake_active, stake_voted = EXCLUDED.stake_voted, snapshot_height = EXCLUDED.snapshot_height`,
      [epoch, amountGroth(row[1]), amountGroth(row[2]), h],
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
  for (let i = 0; i < rows.length; i++) {
    const id = i + 1; // Nth AddProposal call -> proposal id N
    const r = rows[i]!;
    const text = r.args?.text != null ? String(r.args.text) : null;
    const moderator = r.args?.moderator != null ? String(r.args.moderator) : null;
    await q(
      `UPDATE dao_proposals SET text = $2, moderator_pk = $3, height = $4, block_ts = $5 WHERE proposal_id = $1`,
      [id, text, moderator, Number(r.height), r.block_ts],
    );
  }
}

/** Ingest individual votes (with exact stake-weight) from the decoded
 *  "User votes" log table. Each UserVote event carries the voter's stake and
 *  their per-proposal choices for one epoch; choices[i] -> the epoch's i-th
 *  proposal (id order). Idempotent (PK proposal_id, voter_pk, height). */
export async function projectDaoVotes(): Promise<void> {
  const cid = config.DAO_VOTE_CID;
  if (!cid) return;
  const resp = await getContract({ id: cid, state: true, nMaxTxs: 0 });
  const rows = stateTableRows(resp.State ?? {}, 'User votes').filter(Array.isArray) as unknown[][];
  if (rows.length === 0) return;

  // epoch -> ordered proposal ids, and proposal id -> epoch.
  const { rows: propRows } = await q<{ proposal_id: string; epoch: number }>(
    'SELECT proposal_id, epoch FROM dao_proposals ORDER BY epoch, proposal_id',
  );
  const epochProps = new Map<number, number[]>();
  const epochOfProposal0 = new Map<number, number>();
  for (const r of propRows) {
    const pid = Number(r.proposal_id);
    const arr = epochProps.get(r.epoch) ?? [];
    if (arr.length === 0) epochOfProposal0.set(pid, r.epoch); // first id of the epoch
    arr.push(pid);
    epochProps.set(r.epoch, arr);
  }

  const heights = [...new Set(rows.map((row) => cellNum(row[0])).filter((h): h is number => h != null))];
  const tsMap = await getBlockTsMap(heights);

  for (const row of rows) {
    const height = cellNum(row[0]);
    const voter = row[1] && typeof row[1] === 'object' && 'value' in row[1]
      ? String((row[1] as { value: unknown }).value)
      : row[1] != null ? String(row[1]) : null;
    const proposal0 = cellNum(row[2]);
    const stake = amountGroth(row[3]);
    if (height == null || !voter || proposal0 == null) continue;

    const epoch = epochOfProposal0.get(proposal0);
    if (epoch == null) continue;              // proposals for this epoch not snapshotted yet — next tick
    const ordered = epochProps.get(epoch) ?? [];
    const ts = tsMap.get(height);
    if (ts == null) continue;                 // block ts not resolvable yet — next tick

    const bytes = choiceBytes(row[4]);
    for (let i = 0; i < bytes.length && i < ordered.length; i++) {
      if (bytes[i] === 0xff) continue;        // s_NoVote
      await q(
        `INSERT INTO dao_votes (proposal_id, voter_pk, variant, weight_groth, height, block_ts)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (proposal_id, voter_pk, height)
         DO UPDATE SET variant = EXCLUDED.variant, weight_groth = EXCLUDED.weight_groth, block_ts = EXCLUDED.block_ts`,
        [ordered[i]!, voter, bytes[i]!, stake, height, ts],
      );
    }
  }
}

/** One tick of the DaoVote projection: state snapshot, then proposal text enrichment. */
export async function projectDaoVote(): Promise<void> {
  await snapshotDaoVoteState();
  await projectDaoProposalTexts();
  await projectDaoVotes();
}
