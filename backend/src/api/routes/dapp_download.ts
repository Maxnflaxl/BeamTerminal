import type { FastifyInstance } from 'fastify';
import { getIpfs, WalletApiUnavailableError } from '../../walletApi.js';
import { BadRequest, ApiError } from '../error.js';

// ---------------------------------------------------------------------------
// GET /api/dapp/:cid
//
// Streams a .dapp bundle out of BEAM's private mainnet IPFS swarm. The
// transport is wallet-api → asio-ipfs → bitswap, see walletApi.ts::getIpfs.
//
// Frontend Download button is just an `<a download href="/api/dapp/<cid>?
// filename=<sanitized-name>-v<ver>.dapp">`, so we set Content-Disposition
// to the supplied filename and let the browser handle save/progress UI.
//
// Open gateway by design — the user picked "stream any CID" when planning
// this. No allowlist check against the indexer's `dapps` table.
// ---------------------------------------------------------------------------

const CID_RE = /^[A-Za-z0-9]{40,80}$/;
// 90 s lines up with `IPFSConfig.kIpfsTimeout` in beam-ui's apps_view.cpp
// — that's the worst-case wallets are tuned to tolerate too.
const IPFS_TIMEOUT_SEC = 90;
const FILENAME_SAFE_RE = /[^A-Za-z0-9._\- ]+/g;

function sanitizeFilename(s: string): string {
  return s
    .replace(FILENAME_SAFE_RE, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120) || 'dapp.dapp';
}

export const dappDownloadRoutes = async (app: FastifyInstance): Promise<void> => {
  app.get<{ Params: { cid: string }; Querystring: { filename?: string } }>(
    '/dapp/:cid',
    async (req, reply) => {
      const { cid } = req.params;
      if (!CID_RE.test(cid)) {
        throw BadRequest('BAD_CID', 'cid does not look like a valid IPFS CID');
      }
      const filename = sanitizeFilename(req.query.filename ?? `${cid}.dapp`);

      let bytes: Buffer;
      try {
        bytes = await getIpfs(cid, IPFS_TIMEOUT_SEC);
      } catch (err) {
        if (err instanceof WalletApiUnavailableError) {
          throw new ApiError(503, 'IPFS_UNAVAILABLE', 'wallet-api IPFS is not configured');
        }
        const msg = err instanceof Error ? err.message : String(err);
        // wallet-api surfaces fetch failures (timeout, peer unreachable, etc.)
        // as RPC errors — bubble as 504 so callers can distinguish from a
        // 500 in our own code.
        throw new ApiError(504, 'IPFS_FETCH_FAILED', `failed to fetch ${cid}: ${msg}`);
      }

      void reply
        .header('Content-Type', 'application/zip')
        .header('Content-Disposition', `attachment; filename="${filename}"`)
        // CIDs are immutable — long browser cache is safe.
        .header('Cache-Control', 'public, max-age=86400, immutable')
        .header('Access-Control-Allow-Origin', '*')
        .send(bytes);
    },
  );
};
