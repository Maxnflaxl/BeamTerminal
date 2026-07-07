import { config } from '../../config.js';
import { q } from '../../db.js';

// Governance read model over the dao_* tables (filled by services/daoGovernance.ts).
// Enrichment done here (not in the explorer parser, which stays a raw decoder):
//  - proposal title/description/quorum are base64-JSON in the proposal text
//  - variant labels are the binary Yes/No convention (variant 0 = No, 1 = Yes)
//  - outcome = YES stake >= quorum% of the total staked base
// A proposal created in epoch E is voted in epoch E+1; dao_proposals.epoch is the
// creation epoch (to match the DAO app), so its turnout uses epoch E+1's stats.

export interface ProposalMeta {
  title: string | null;
  description: string | null;
  forum_link: string | null;
  quorum_pct: number | null;
}

export function decodeProposalText(textB64: string | null): ProposalMeta {
  const empty: ProposalMeta = { title: null, description: null, forum_link: null, quorum_pct: null };
  if (!textB64) return empty;
  try {
    const parsed = JSON.parse(Buffer.from(textB64, 'base64').toString('utf-8')) as {
      title?: unknown;
      description?: unknown;
      forum_link?: unknown;
      quorum?: { value?: unknown; type?: unknown };
    };
    const quorum = parsed.quorum;
    const pct = quorum && quorum.type === 'percent' && quorum.value != null ? Number(quorum.value) : NaN;
    return {
      title: parsed.title != null ? String(parsed.title) : null,
      description: parsed.description != null ? String(parsed.description) : null,
      forum_link: parsed.forum_link != null ? String(parsed.forum_link) : null,
      quorum_pct: Number.isFinite(pct) ? pct : null,
    };
  } catch {
    return empty;
  }
}

/** Binary DAO proposals: variant 0 = No, 1 = Yes; anything else → "Option N". */
export function variantLabel(variant: number, variantCount: number): string {
  if (variantCount === 2) return variant === 1 ? 'Yes' : 'No';
  return `Option ${variant + 1}`;
}

export type Outcome = 'passed' | 'failed' | 'pending' | null;

/** YES (variant 1) stake must reach quorum% of the total staked base to pass. */
export function computeOutcome(
  tallies: ReadonlyArray<{ variant: number; stake_groth: string }>,
  quorumPct: number | null,
  totalStakedGroth: number,
  live: boolean,
): { outcome: Outcome; yes_needed: string | null } {
  const yes = Number(tallies.find((t) => t.variant === 1)?.stake_groth ?? 0);
  // Proposals with no quorum in their JSON pass on a simple majority (Yes > No).
  if (quorumPct == null) {
    if (live) return { outcome: 'pending', yes_needed: null };
    const no = Number(tallies.find((t) => t.variant === 0)?.stake_groth ?? 0);
    return { outcome: yes > no ? 'passed' : 'failed', yes_needed: null };
  }
  if (totalStakedGroth <= 0) return { outcome: null, yes_needed: null };
  const needed = Math.round((quorumPct / 100) * totalStakedGroth);
  if (live) return { outcome: 'pending', yes_needed: String(needed) };
  return { outcome: yes >= needed ? 'passed' : 'failed', yes_needed: String(needed) };
}

export interface DaoTally {
  variant: number;
  label: string;
  stake: string;
  pct: number;
}

export interface DaoProposalSummary {
  id: number;
  epoch: number;
  title: string | null;
  status: 'live' | 'closed';
  outcome: Outcome;
  variant_count: number;
  quorum_pct: number | null;
  yes_needed: string | null;
  turnout_pct: number | null;
  voted_groth: string;
  tallies: DaoTally[];
}

export interface DaoGovernance {
  current_epoch: number | null;
  total_staked: string | null;
  kpis: { active_proposals: number; turnout_pct: number | null; voting_power: string | null; voters: number };
  voting_power_series: { day: string; staked: number }[];
  epochs: number[];
  proposals: DaoProposalSummary[];
}

interface TallyRow {
  proposal_id: string;
  variant: number;
  stake_groth: string;
}

function talliesFor(rows: ReadonlyArray<TallyRow>, variantCount: number): DaoTally[] {
  const total = rows.reduce((s, r) => s + Number(r.stake_groth), 0);
  return rows
    .map((r) => ({
      variant: r.variant,
      label: variantLabel(r.variant, variantCount),
      stake: r.stake_groth,
      pct: total > 0 ? (Number(r.stake_groth) / total) * 100 : 0,
    }))
    .sort((a, b) => a.variant - b.variant);
}

export async function loadDaoGovernance(): Promise<DaoGovernance> {
  const emptyKpis: DaoGovernance['kpis'] = { active_proposals: 0, turnout_pct: null, voting_power: null, voters: 0 };
  if (!config.DAO_VOTE_CID) {
    return { current_epoch: null, total_staked: null, kpis: emptyKpis, voting_power_series: [], epochs: [], proposals: [] };
  }

  const { rows: epRows } = await q<{ epoch: number; stake_active: string }>(
    'SELECT epoch, stake_active FROM dao_epoch_stats ORDER BY epoch DESC',
  );
  const epochs = epRows.map((r) => r.epoch);
  const current = epochs.length ? epochs[0]! : null;
  const totalStaked = epRows.length ? epRows[0]!.stake_active : null; // current epoch = total staked base
  const totalStakedGroth = totalStaked != null ? Number(totalStaked) : 0;
  const activeByEpoch = new Map<number, number>(epRows.map((r) => [r.epoch, Number(r.stake_active)]));

  const { rows: vpRows } = await q<{ day: string; delta: string }>(
    `SELECT to_char(date_trunc('day', block_ts), 'YYYY-MM-DD') AS day,
            SUM(CASE WHEN method = 'Funds Lock'   THEN (args->>'amount')::numeric
                     WHEN method = 'Funds Unlock' THEN -(args->>'amount')::numeric
                     ELSE 0 END)::text AS delta
       FROM contract_call_events
      WHERE cid = $1 AND method IN ('Funds Lock', 'Funds Unlock')
      GROUP BY 1 ORDER BY 1`,
    [config.DAO_VOTE_CID],
  );
  let run = 0;
  const voting_power_series = vpRows.map((r) => {
    run += Number(r.delta) / 1e8;
    return { day: r.day, staked: run };
  });

  const { rows: pRows } = await q<{ id: string; epoch: number; text: string | null; variant_count: number }>(
    'SELECT proposal_id AS id, epoch, text, variant_count FROM dao_proposals ORDER BY proposal_id DESC',
  );
  const { rows: tRows } = await q<TallyRow>(
    'SELECT proposal_id, variant, stake_groth FROM dao_proposal_tallies',
  );
  const talliesByProp = new Map<number, TallyRow[]>();
  for (const t of tRows) {
    const pid = Number(t.proposal_id);
    (talliesByProp.get(pid) ?? talliesByProp.set(pid, []).get(pid)!).push(t);
  }

  const proposals: DaoProposalSummary[] = pRows.map((r) => {
    const id = Number(r.id);
    const meta = decodeProposalText(r.text);
    const rawTallies = talliesByProp.get(id) ?? [];
    const tallies = talliesFor(rawTallies, r.variant_count);
    const votedGroth = rawTallies.reduce((s, t) => s + Number(t.stake_groth), 0);
    const votingActive = activeByEpoch.get(r.epoch + 1) ?? 0; // proposal voted in epoch+1
    const live = current != null && r.epoch + 1 === current;
    const { outcome, yes_needed } = computeOutcome(rawTallies, meta.quorum_pct, totalStakedGroth, live);
    return {
      id,
      epoch: r.epoch,
      title: meta.title,
      status: live ? 'live' : 'closed',
      outcome,
      variant_count: r.variant_count,
      quorum_pct: meta.quorum_pct,
      yes_needed,
      turnout_pct: votingActive > 0 ? (votedGroth / votingActive) * 100 : null,
      voted_groth: String(votedGroth),
      tallies,
    };
  });

  let kpis = emptyKpis;
  if (current != null) {
    kpis = {
      active_proposals: proposals.filter((p) => p.status === 'live').length,
      turnout_pct: null, // no live votes accumulate in EpochStats until epoch close; per-proposal turnout is authoritative
      voting_power: totalStaked,
      voters: 0,
    };
  }

  return { current_epoch: current, total_staked: totalStaked, kpis, voting_power_series, epochs, proposals };
}

export interface DaoProposalDetail {
  proposal: (DaoProposalSummary & { description: string | null; forum_link: string | null }) | null;
  votes: { total: number; rows: { voter: string; variant: number; label: string; weight: string | null; height: number }[] };
}

export async function loadDaoProposal(id: number, offset: number, limit: number): Promise<DaoProposalDetail> {
  const empty: DaoProposalDetail = { proposal: null, votes: { total: 0, rows: [] } };
  if (!config.DAO_VOTE_CID) return empty;

  const { rows: pRows } = await q<{ id: string; epoch: number; text: string | null; variant_count: number; current: number | null }>(
    `SELECT proposal_id AS id, epoch, text, variant_count,
            (SELECT max(epoch) FROM dao_epoch_stats) AS current
       FROM dao_proposals WHERE proposal_id = $1`,
    [id],
  );
  const p = pRows[0];
  if (!p) return empty;

  const { rows: tRows } = await q<TallyRow>(
    'SELECT proposal_id, variant, stake_groth FROM dao_proposal_tallies WHERE proposal_id = $1',
    [id],
  );
  const { rows: esRows } = await q<{ stake_active: string }>(
    'SELECT stake_active FROM dao_epoch_stats WHERE epoch = $1',
    [p.epoch + 1],
  );
  const { rows: baseRows } = await q<{ stake_active: string }>(
    'SELECT stake_active FROM dao_epoch_stats ORDER BY epoch DESC LIMIT 1',
  );
  const meta = decodeProposalText(p.text);
  const tallies = talliesFor(tRows, p.variant_count);
  const votedGroth = tRows.reduce((s, t) => s + Number(t.stake_groth), 0);
  const votingActive = esRows[0] ? Number(esRows[0].stake_active) : 0;
  const totalStakedGroth = baseRows[0] ? Number(baseRows[0].stake_active) : 0;
  const live = p.current != null && p.epoch + 1 === p.current;
  const { outcome, yes_needed } = computeOutcome(tRows, meta.quorum_pct, totalStakedGroth, live);

  const { rows: cntRows } = await q<{ n: string }>('SELECT count(*)::text AS n FROM dao_votes WHERE proposal_id = $1', [id]);
  const { rows: vRows } = await q<{ voter_pk: string; variant: number; weight_groth: string | null; height: string }>(
    `SELECT voter_pk, variant, weight_groth, height FROM dao_votes WHERE proposal_id = $1
      ORDER BY weight_groth DESC NULLS LAST, height DESC LIMIT $2 OFFSET $3`,
    [id, limit, offset],
  );

  return {
    proposal: {
      id: Number(p.id),
      epoch: p.epoch,
      title: meta.title,
      description: meta.description,
      forum_link: meta.forum_link,
      status: live ? 'live' : 'closed',
      outcome,
      variant_count: p.variant_count,
      quorum_pct: meta.quorum_pct,
      yes_needed,
      turnout_pct: votingActive > 0 ? (votedGroth / votingActive) * 100 : null,
      voted_groth: String(votedGroth),
      tallies,
    },
    votes: {
      total: cntRows[0] ? Number(cntRows[0].n) : 0,
      rows: vRows.map((v) => ({
        voter: v.voter_pk,
        variant: v.variant,
        label: variantLabel(v.variant, p.variant_count),
        weight: v.weight_groth,
        height: Number(v.height),
      })),
    },
  };
}
