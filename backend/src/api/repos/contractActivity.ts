import { config } from '../../config.js';
import { q } from '../../db.js';

export interface BansAction {
  height: number;
  block_ts: string;
  method: string;
  name: string | null;
  args: Record<string, unknown> | null;
}

export interface BansActionsResult {
  actions: BansAction[];
  meta: { total: number; first_height: number | null; last_height: number | null };
}

/** All primary BANS calls, oldest→newest. Nested calls (parent_ord not null)
 *  are excluded — they're the Oracle/DaoVault sub-calls, not user actions. */
export async function loadBansActions(): Promise<BansActionsResult> {
  if (!config.BANS_CID) {
    return { actions: [], meta: { total: 0, first_height: null, last_height: null } };
  }
  const { rows } = await q<{ height: string; block_ts: Date; method: string; name: string | null; args: Record<string, unknown> | null }>(
    `SELECT height, block_ts, method, name, args
       FROM contract_call_events
      WHERE cid = $1 AND parent_ord IS NULL
      ORDER BY height ASC, ord ASC`,
    [config.BANS_CID],
  );
  const actions: BansAction[] = rows.map((r) => ({
    height: Number(r.height),
    block_ts: r.block_ts.toISOString(),
    method: r.method,
    name: r.name,
    args: r.args,
  }));
  return {
    actions,
    meta: {
      total: actions.length,
      first_height: actions.length ? actions[0]!.height : null,
      last_height: actions.length ? actions[actions.length - 1]!.height : null,
    },
  };
}
