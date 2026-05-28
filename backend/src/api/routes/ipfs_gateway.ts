import type { FastifyInstance } from 'fastify';
import { getIpfs, WalletApiUnavailableError } from '../../walletApi.js';
import { BadRequest, ApiError } from '../error.js';

// ---------------------------------------------------------------------------
// GET /ipfs/:cid
//
// Public IPFS gateway shape (`https://<host>/ipfs/<cid>`) that other tools
// already speak. Pipes bytes from BEAM's private mainnet swarm via wallet-api
// → asio-ipfs → bitswap (same transport `/api/dapp/:cid` uses).
//
// Default disposition is inline — the browser renders images, PDFs, JSON etc.
// directly. Standard query-string overrides supported, matching public
// gateways like dweb.link / ipfs.io:
//
//   ?download=true            attachment; filename="<cid>"
//   ?download=true&filename=…  attachment; filename="<sanitized>"
//   ?filename=…                inline; filename="<sanitized>"  (hint only)
//
// Content-Type is sniffed from the first few bytes — wallet-api's `ipfs_get`
// returns raw blob bytes with no MIME metadata. Unknown blobs fall back to
// `application/octet-stream`, which is what public gateways do too.
//
// Security: this serves attacker-controlled bytes on a first-party origin.
// HTML / SVG / XML / WASM are active content and would otherwise execute in
// `beamterminal.0xmx.net`'s origin (cookie + storage access). Those types
// get coerced to octet-stream + forced attachment. Every response also
// carries CSP `default-src 'none'; sandbox`, `X-Content-Type-Options: nosniff`,
// and `X-Frame-Options: DENY` so that even a slipped type can't script.
// Standalone gateways usually mitigate this by serving from a separate
// cookieless origin (e.g. cf-ipfs.com); we can switch to that pattern
// later if we ever set cookies on this domain — today the SPA doesn't.
//
// Limitations vs a Kubo gateway:
//   * No range / partial-content support — `ipfs_get` is JSON-RPC and loads
//     the whole blob into memory both sides.
//   * No directory walk (`/ipfs/<cid>/sub/file`) — asio-ipfs resolves a CID
//     to bytes, not a UnixFS subtree. `/ipfs/:cid` is the entire surface.
// ---------------------------------------------------------------------------

const CID_RE = /^[A-Za-z0-9]{40,80}$/;
// Same upper bound as /api/dapp/:cid; ~4× the wallet's own kIpfsTimeout.
const IPFS_TIMEOUT_MS = 90_000;
const FILENAME_SAFE_RE = /[^A-Za-z0-9._\- ]+/g;

function sanitizeFilename(s: string): string {
  return s
    .replace(FILENAME_SAFE_RE, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120) || 'download';
}

// Magic-byte sniff of common types. Deliberately small set — gateways aren't
// in the business of guessing application types beyond what browsers render
// natively. Anything unknown is octet-stream; callers can pass an explicit
// filename so the browser/save-dialog gets a usable extension.
function sniffContentType(buf: Buffer): string {
  if (buf.length < 4) return 'application/octet-stream';

  const b0 = buf[0], b1 = buf[1], b2 = buf[2], b3 = buf[3];

  // PK\x03\x04 / \x05\x06 / \x07\x08 — zip family (incl .dapp)
  if (b0 === 0x50 && b1 === 0x4B && (b2 === 0x03 || b2 === 0x05 || b2 === 0x07)) {
    return 'application/zip';
  }
  // \x89PNG
  if (b0 === 0x89 && b1 === 0x50 && b2 === 0x4E && b3 === 0x47) return 'image/png';
  // \xFF\xD8\xFF — JPEG
  if (b0 === 0xFF && b1 === 0xD8 && b2 === 0xFF) return 'image/jpeg';
  // GIF8(7|9)a
  if (b0 === 0x47 && b1 === 0x49 && b2 === 0x46 && b3 === 0x38) return 'image/gif';
  // RIFF....WEBP
  if (buf.length >= 12
    && b0 === 0x52 && b1 === 0x49 && b2 === 0x46 && b3 === 0x46
    && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
    return 'image/webp';
  }
  // %PDF-
  if (b0 === 0x25 && b1 === 0x50 && b2 === 0x44 && b3 === 0x46) return 'application/pdf';
  // \0asm
  if (b0 === 0x00 && b1 === 0x61 && b2 === 0x73 && b3 === 0x6D) return 'application/wasm';
  // ....ftyp — MP4 / MOV
  if (buf.length >= 12
    && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
    return 'video/mp4';
  }

  // Text-ish: look at the first non-whitespace chars.
  const head = buf.subarray(0, Math.min(96, buf.length)).toString('utf8').trimStart();
  if (head.startsWith('<?xml') || /^<svg[\s>]/i.test(head)) return 'image/svg+xml';
  if (/^<!doctype html|^<html/i.test(head)) return 'text/html; charset=utf-8';
  if (head.startsWith('{') || head.startsWith('[')) return 'application/json; charset=utf-8';

  return 'application/octet-stream';
}

// MIME types whose payloads can script in the serving origin. We never let
// these go inline — coerce to octet-stream and force attachment so the
// browser saves the file instead of rendering it.
const UNSAFE_INLINE_TYPES = new Set([
  'text/html; charset=utf-8',
  'image/svg+xml',
  'application/xml',
  'application/xhtml+xml',
  'application/wasm',
]);

export const ipfsGatewayRoutes = async (app: FastifyInstance): Promise<void> => {
  app.get<{ Params: { cid: string }; Querystring: { download?: string; filename?: string } }>(
    '/ipfs/:cid',
    async (req, reply) => {
      const { cid } = req.params;
      if (!CID_RE.test(cid)) {
        throw BadRequest('BAD_CID', 'cid does not look like a valid IPFS CID');
      }

      let bytes: Buffer;
      try {
        bytes = await getIpfs(cid, IPFS_TIMEOUT_MS);
      } catch (err) {
        if (err instanceof WalletApiUnavailableError) {
          throw new ApiError(503, 'IPFS_UNAVAILABLE', 'wallet-api IPFS is not configured');
        }
        const msg = err instanceof Error ? err.message : String(err);
        throw new ApiError(504, 'IPFS_FETCH_FAILED', `failed to fetch ${cid}: ${msg}`);
      }

      const sniffed = sniffContentType(bytes);
      // Active-content types script in our origin if rendered inline. Coerce
      // to octet-stream + force attachment so the browser only ever saves
      // them. See route header comment for the threat model.
      const isUnsafeInline = UNSAFE_INLINE_TYPES.has(sniffed);
      const contentType = isUnsafeInline ? 'application/octet-stream' : sniffed;

      const userWantsDownload = req.query.download === 'true' || req.query.download === '1';
      const forceAttachment = userWantsDownload || isUnsafeInline;
      const rawFilename = typeof req.query.filename === 'string' ? req.query.filename : undefined;

      void reply
        .header('Content-Type', contentType)
        // CIDs are immutable — year-long browser cache + Cloudflare cache.
        .header('Cache-Control', 'public, max-age=31536000, immutable')
        .header('Access-Control-Allow-Origin', '*')
        // Defense-in-depth in case a sniff slips past — the browser must not
        // re-guess the type and must not execute anything if it does render.
        .header('X-Content-Type-Options', 'nosniff')
        .header('X-Frame-Options', 'DENY')
        .header('Content-Security-Policy', "default-src 'none'; sandbox; frame-ancestors 'none'");

      if (forceAttachment) {
        const filename = sanitizeFilename(rawFilename ?? cid);
        void reply.header('Content-Disposition', `attachment; filename="${filename}"`);
      } else if (rawFilename) {
        const filename = sanitizeFilename(rawFilename);
        void reply.header('Content-Disposition', `inline; filename="${filename}"`);
      }

      void reply.send(bytes);
    },
  );
};
