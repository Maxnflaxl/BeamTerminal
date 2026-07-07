import { config } from '../config.js';
import { q } from '../db.js';
import { getContract } from '../explorer.js';

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

/** One tick of the DaoVote projection: state snapshot, then proposal text enrichment. */
export async function projectDaoVote(): Promise<void> {
  await snapshotDaoVoteState();
  await projectDaoProposalTexts();
}
