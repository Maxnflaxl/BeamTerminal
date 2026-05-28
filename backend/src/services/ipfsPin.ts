import { q } from '../db.js';
import { logger } from '../logger.js';
import { pinIpfs, WalletApiUnavailableError } from '../walletApi.js';

// ---------------------------------------------------------------------------
// IPFS-pin worker for the DApp Store catalog.
//
// Mission: BeamTerminal's wallet-api node is the de-facto archival mirror of
// every registered dapp. Whenever a dapp row (current or historical) shows
// up in postgres with a CID that's not yet pinned, we pin it on the
// wallet-api's asio-ipfs daemon — same daemon `/api/dapp/:cid` and `/ipfs/`
// serve from. Pinning forces a Bitswap fetch of the blocks (so they end up
// in our local repo before any user requests them) and protects them from
// future GC even after `--ipfs_run_gc` flips on.
//
// Pacing: only NFTs would justify rate-limiting and pinning is out of scope
// for them anyway, so we pin everything we find in one pass — the dapp set
// is tiny (~20 today). Each pin call is sequential and bounded by
// PIN_TIMEOUT_MS so a stuck CID can't block the rest of the batch.
//
// Failures: on RPC error we leave `ipfs_pinned_at` NULL and log; next tick
// retries. asio-ipfs's pin path can timeout if no swarm peer has the
// content yet — that's expected and benign, the next sync brings it.
// ---------------------------------------------------------------------------

const PIN_TIMEOUT_MS = 60_000;
// Cap per tick — even though we expect <100 unpinned rows in practice, a
// pathological reset (drop the repo, rebuild) would blast wallet-api. Keep
// per-tick work bounded and let the next tick continue the backlog.
const MAX_PINS_PER_TICK = 50;

type UnpinnedRef =
  | { cid: string; table: 'dapps'; dappId: string }
  | { cid: string; table: 'dapp_versions'; dappId: string; height: string; action: number };

async function selectUnpinned(limit: number): Promise<UnpinnedRef[]> {
  // Current dapps first — those are the user-visible ones. Then history.
  const rows: UnpinnedRef[] = [];

  const dapps = await q<{ id: string; ipfs_id: string }>(
    `SELECT id, ipfs_id
       FROM dapps
      WHERE ipfs_pinned_at IS NULL
        AND ipfs_id IS NOT NULL
      ORDER BY last_updated_height DESC NULLS LAST, id
      LIMIT $1`,
    [limit],
  );
  for (const r of dapps.rows) {
    rows.push({ cid: r.ipfs_id, table: 'dapps', dappId: r.id });
  }

  const remaining = limit - rows.length;
  if (remaining > 0) {
    const versions = await q<{ dapp_id: string; ipfs_hash: string; height: string; action: number }>(
      `SELECT dapp_id, ipfs_hash, height::text, action
         FROM dapp_versions
        WHERE ipfs_pinned_at IS NULL
          AND ipfs_hash IS NOT NULL
        ORDER BY height DESC, dapp_id
        LIMIT $1`,
      [remaining],
    );
    for (const r of versions.rows) {
      rows.push({
        cid: r.ipfs_hash,
        table: 'dapp_versions',
        dappId: r.dapp_id,
        height: r.height,
        action: r.action,
      });
    }
  }

  return rows;
}

async function markPinned(ref: UnpinnedRef): Promise<void> {
  if (ref.table === 'dapps') {
    await q(
      `UPDATE dapps SET ipfs_pinned_at = now() WHERE id = $1`,
      [ref.dappId],
    );
  } else {
    await q(
      `UPDATE dapp_versions
          SET ipfs_pinned_at = now()
        WHERE dapp_id = $1 AND height = $2 AND action = $3`,
      [ref.dappId, ref.height, ref.action],
    );
  }
}

export interface PinSyncResult {
  pinned: number;
  failed: number;
  remaining: number;
}

export async function syncIpfsPins(): Promise<PinSyncResult | null> {
  const refs = await selectUnpinned(MAX_PINS_PER_TICK);
  if (refs.length === 0) return null;

  let pinned = 0;
  let failed = 0;
  for (const ref of refs) {
    try {
      await pinIpfs(ref.cid, PIN_TIMEOUT_MS);
      await markPinned(ref);
      pinned += 1;
    } catch (err) {
      if (err instanceof WalletApiUnavailableError) {
        logger.debug('ipfs-pin: wallet-api not configured; skipping');
        return null;
      }
      failed += 1;
      logger.warn(
        { err: err instanceof Error ? err.message : err, cid: ref.cid, table: ref.table, dapp_id: ref.dappId },
        'ipfs-pin: pin failed; will retry next tick',
      );
    }
  }

  // Cheap follow-up count so the log line tells us whether we're caught up.
  const remainingRow = await q<{ count: string }>(
    `SELECT (
       (SELECT count(*) FROM dapps          WHERE ipfs_pinned_at IS NULL AND ipfs_id   IS NOT NULL)
     + (SELECT count(*) FROM dapp_versions  WHERE ipfs_pinned_at IS NULL AND ipfs_hash IS NOT NULL)
     )::text AS count`,
  );
  const remaining = Number(remainingRow.rows[0]?.count ?? 0);

  return { pinned, failed, remaining };
}
