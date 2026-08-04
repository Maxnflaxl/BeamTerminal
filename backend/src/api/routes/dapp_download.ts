import type { FastifyInstance } from 'fastify';
import { getIpfs, WalletApiUnavailableError } from '../../walletApi.js';
import { BadRequest, ApiError } from '../error.js';
import { logger } from '../../logger.js';

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
// 60 000 ms — generous, but dapp bundles are a few MB and the first
// fetch from a cold cache can take a while. The wallet itself uses 20 s
// (beam-ui/apps_view.cpp:40 kIpfsTimeout = 20 * 1000); we go higher
// because a backend retry costs less than a failed user download.
//
// Upper bound is Cloudflare's 100 s origin-response limit: exceed it and the
// user gets an opaque CF 504 instead of the JSON error below, which the
// Download button needs in order to explain what went wrong.
const IPFS_TIMEOUT_MS = 60_000;
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
        // wallet-api collapses every IPFS failure into one opaque RPC error
        // (-32022 IPFSError, see beam/wallet/api/base/api_errors.h), so we
        // can't tell a timeout from a malformed CID. In practice the only
        // failure users hit is "no peer on the swarm has these blocks" —
        // the publisher's node went offline and we never mirrored the CID.
        // Say that, rather than echoing an error code nobody can act on.
        logger.warn({ cid, err: msg }, 'dapp download: ipfs fetch failed');
        // 503, not 504: Cloudflare replaces an origin 502/504 with its own
        // branded error page, so the body below never reaches the browser.
        // 503 passes through untouched and says the same thing — the content
        // is unavailable right now, try later.
        throw new ApiError(
          503,
          'IPFS_CONTENT_UNAVAILABLE',
          `No peer on BEAM's IPFS swarm is currently serving ${cid}. ` +
            `The publisher's node is probably offline — try again later.`,
        );
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
