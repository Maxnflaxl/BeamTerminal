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
// 90 000 ms — generous, but dapp bundles are a few MB and the first
// fetch from a cold cache can take a while. The wallet itself uses 20 s
// (beam-ui/apps_view.cpp:40 kIpfsTimeout = 20 * 1000); we go higher
// because a backend retry costs less than a failed user download.
const IPFS_TIMEOUT_MS = 90_000;
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
        bytes = await getIpfs(cid, IPFS_TIMEOUT_MS);
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
        // Defense-in-depth: even though we already force attachment + zip,
        // make sure a misconfigured browser can't sniff this as HTML and
        // script in our origin.
        .header('X-Content-Type-Options', 'nosniff')
        .header('X-Frame-Options', 'DENY')
        .header('Content-Security-Policy', "default-src 'none'; sandbox; frame-ancestors 'none'")
        .send(bytes);
    },
  );
};
