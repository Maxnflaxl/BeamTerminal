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
// Failures: on RPC error we leave `ipfs_pinned_at` NULL, bump the attempt
// counter and log; a later tick retries. asio-ipfs's pin path can timeout if
// no swarm peer has the content yet — that's expected and benign, the next
// sync brings it.
//
// Backoff: a CID that no peer serves fails after the full PIN_TIMEOUT_MS,
// every time. Retrying it every tick costs a minute of the indexer's tick
// budget per row and never succeeds, so back off exponentially — a publisher
// that comes back online days later is still picked up, at a cost that
// decays instead of compounding.
//
// Tombstoned dapps are skipped entirely: the publisher pulled the release,
// so there's nothing to archive and usually nobody left serving it. Already
// pinned bundles stay pinned — we never unpin history.
// ---------------------------------------------------------------------------

const PIN_TIMEOUT_MS = 60_000;
// 1st retry after ~1 min, then 2, 4, 8 … capped by the exponent clamp at
// ~8.5 h. Expressed in SQL so the filter stays in the index scan.
const BACKOFF_SQL = `(interval '1 minute' * power(2, least(ipfs_pin_attempts, 9)))`;
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
        AND deleted_at IS NULL
        AND (ipfs_pin_last_attempt_at IS NULL
             OR ipfs_pin_last_attempt_at < now() - ${BACKOFF_SQL})
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
      `SELECT v.dapp_id, v.ipfs_hash, v.height::text, v.action
         FROM dapp_versions v
         JOIN dapps d ON d.id = v.dapp_id
        WHERE v.ipfs_pinned_at IS NULL
          AND v.ipfs_hash IS NOT NULL
          AND d.deleted_at IS NULL
          AND (v.ipfs_pin_last_attempt_at IS NULL
               OR v.ipfs_pin_last_attempt_at < now() - ${BACKOFF_SQL.replace(/ipfs_pin_attempts/g, 'v.ipfs_pin_attempts')})
        ORDER BY v.height DESC, v.dapp_id
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

async function markAttemptFailed(ref: UnpinnedRef): Promise<void> {
  if (ref.table === 'dapps') {
    await q(
      `UPDATE dapps
          SET ipfs_pin_attempts = ipfs_pin_attempts + 1,
              ipfs_pin_last_attempt_at = now()
        WHERE id = $1`,
      [ref.dappId],
    );
  } else {
    await q(
      `UPDATE dapp_versions
          SET ipfs_pin_attempts = ipfs_pin_attempts + 1,
              ipfs_pin_last_attempt_at = now()
        WHERE dapp_id = $1 AND height = $2 AND action = $3`,
      [ref.dappId, ref.height, ref.action],
    );
  }
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
      await markAttemptFailed(ref);
      logger.warn(
        { err: err instanceof Error ? err.message : err, cid: ref.cid, table: ref.table, dapp_id: ref.dappId },
        'ipfs-pin: pin failed; will retry after backoff',
      );
    }
  }

  // Cheap follow-up count so the log line tells us whether we're caught up.
  // Counts outstanding work regardless of backoff, but excludes tombstoned
  // dapps — those are never coming, and reporting them as backlog forever
  // is what hid the retry loop in the first place.
  const remainingRow = await q<{ count: string }>(
    `SELECT (
       (SELECT count(*)
          FROM dapps
         WHERE ipfs_pinned_at IS NULL AND ipfs_id IS NOT NULL AND deleted_at IS NULL)
     + (SELECT count(*)
          FROM dapp_versions v
          JOIN dapps d ON d.id = v.dapp_id
         WHERE v.ipfs_pinned_at IS NULL AND v.ipfs_hash IS NOT NULL AND d.deleted_at IS NULL)
     )::text AS count`,
  );
  const remaining = Number(remainingRow.rows[0]?.count ?? 0);

  return { pinned, failed, remaining };
}
