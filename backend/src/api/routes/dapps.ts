import type { FastifyInstance } from 'fastify';
import { q } from '../../db.js';
import { NotFound } from '../error.js';

// ---------------------------------------------------------------------------
// /api/dapps             — registered dapps (joined to publisher).
// /api/dapps/:id         — single dapp + version history.
// /api/dapps/publishers  — known publishers, sorted by dapps published.
// /api/dapps/calls       — recent raw calls (debugging the projection).
//
// While the projection is still maturing (see services/dappStore.ts),
// /api/dapps/calls is the canonical source of truth — read it to see what's
// actually in the registry.
// ---------------------------------------------------------------------------

interface DappRow {
  id: string;
  publisher_pubkey: string;
  publisher_name: string | null;
  name: string | null;
  description: string | null;
  category: number | null;
  icon: string | null;
  ipfs_id: string | null;
  api_version: string | null;
  min_api_version: string | null;
  version: string | null;
  version_major: number | null;
  version_minor: number | null;
  version_release: number | null;
  version_build: number | null;
  first_seen_height: string;
  first_seen_at: Date;
  last_updated_height: string;
  last_updated_at: Date;
  deleted_at: Date | null;
}

interface PublisherRow {
  pubkey: string;
  name: string | null;
  short_title: string | null;
  about_me: string | null;
  website: string | null;
  twitter: string | null;
  linkedin: string | null;
  instagram: string | null;
  telegram: string | null;
  discord: string | null;
  first_seen_height: string;
  first_seen_at: Date;
  last_updated_height: string;
  last_updated_at: Date;
  dapps_count: string;
}

interface DappVersionRow {
  version: string | null;
  ipfs_hash: string | null;
  height: string;
  block_ts: Date;
  action: number;
}

interface RawCallRow {
  kernel_id: string;
  call_index: number;
  height: string;
  block_ts: Date;
  action: number | null;
  args: unknown;
  confirmed: boolean;
}

// Shared shape for /dapps and /dapps/:id responses. Compose the version-text
// here when the projector didn't supply one (e.g. partial rows from the
// legacy raw-call projection).
function shapeDapp(r: DappRow): Record<string, unknown> {
  const verText = r.version
    ?? (r.version_major !== null && r.version_minor !== null
      && r.version_release !== null && r.version_build !== null
        ? `${r.version_major}.${r.version_minor}.${r.version_release}.${r.version_build}`
        : null);
  return {
    id: r.id,
    publisher: { pubkey: r.publisher_pubkey, name: r.publisher_name },
    name: r.name,
    description: r.description,
    category: r.category,
    icon: r.icon,
    ipfs_id: r.ipfs_id,
    api_version: r.api_version,
    min_api_version: r.min_api_version,
    version: verText,
    version_parts: {
      major: r.version_major,
      minor: r.version_minor,
      release: r.version_release,
      build: r.version_build,
    },
    first_seen_height: Number(r.first_seen_height),
    first_seen_at: r.first_seen_at.toISOString(),
    last_updated_height: Number(r.last_updated_height),
    last_updated_at: r.last_updated_at.toISOString(),
    deleted_at: r.deleted_at ? r.deleted_at.toISOString() : null,
  };
}

export async function dappsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { include_deleted?: string } }>(
    '/dapps',
    async (req, reply) => {
      const includeDeleted = req.query.include_deleted === '1' || req.query.include_deleted === 'true';
      const { rows } = await q<DappRow>(
        `SELECT d.id, d.publisher_pubkey, p.name AS publisher_name,
                d.name, d.description, d.category, d.icon, d.ipfs_id,
                d.api_version, d.min_api_version, d.version,
                d.version_major, d.version_minor, d.version_release, d.version_build,
                d.first_seen_height::text, d.first_seen_at,
                d.last_updated_height::text, d.last_updated_at,
                d.deleted_at
           FROM dapps d
      LEFT JOIN dapp_publishers p ON p.pubkey = d.publisher_pubkey
          ${includeDeleted ? '' : 'WHERE d.deleted_at IS NULL'}
          ORDER BY d.last_updated_at DESC
          LIMIT 500`,
      );
      void reply.header('cache-control', 'public, max-age=60');
      return {
        dapps: rows.map(shapeDapp),
      };
    },
  );

  app.get<{ Params: { id: string } }>('/dapps/:id', async (req, reply) => {
    const { rows } = await q<DappRow>(
      `SELECT d.id, d.publisher_pubkey, p.name AS publisher_name,
              d.name, d.description, d.category, d.icon, d.ipfs_id,
              d.api_version, d.min_api_version, d.version,
              d.version_major, d.version_minor, d.version_release, d.version_build,
              d.first_seen_height::text, d.first_seen_at,
              d.last_updated_height::text, d.last_updated_at,
              d.deleted_at
         FROM dapps d
    LEFT JOIN dapp_publishers p ON p.pubkey = d.publisher_pubkey
        WHERE d.id = $1`,
      [req.params.id],
    );
    if (rows.length === 0) throw NotFound('DAPP_NOT_FOUND', `dapp not found: ${req.params.id}`);
    const d = rows[0]!;

    const { rows: versions } = await q<DappVersionRow>(
      `SELECT version, ipfs_hash, height::text, block_ts, action
         FROM dapp_versions
        WHERE dapp_id = $1
        ORDER BY height ASC, action ASC`,
      [req.params.id],
    );

    void reply.header('cache-control', 'public, max-age=60');
    return {
      dapp: shapeDapp(d),
      versions: versions.map((v) => ({
        version: v.version,
        ipfs_hash: v.ipfs_hash,
        height: Number(v.height),
        block_ts: v.block_ts.toISOString(),
        action: v.action,
      })),
    };
  });

  app.get('/dapps/publishers', async (_req, reply) => {
    const { rows } = await q<PublisherRow>(
      `SELECT p.pubkey, p.name, p.short_title, p.about_me,
              p.website, p.twitter, p.linkedin, p.instagram, p.telegram, p.discord,
              p.first_seen_height::text, p.first_seen_at,
              p.last_updated_height::text, p.last_updated_at,
              COALESCE(c.cnt, 0)::text AS dapps_count
         FROM dapp_publishers p
    LEFT JOIN (
              SELECT publisher_pubkey, COUNT(*)::int AS cnt
                FROM dapps
               WHERE deleted_at IS NULL
            GROUP BY publisher_pubkey
            ) c ON c.publisher_pubkey = p.pubkey
        ORDER BY COALESCE(c.cnt, 0) DESC, p.last_updated_at DESC
        LIMIT 500`,
    );
    void reply.header('cache-control', 'public, max-age=60');
    return {
      publishers: rows.map((r) => ({
        pubkey: r.pubkey,
        name: r.name,
        short_title: r.short_title,
        about_me: r.about_me,
        website: r.website,
        social: {
          twitter: r.twitter,
          linkedin: r.linkedin,
          instagram: r.instagram,
          telegram: r.telegram,
          discord: r.discord,
        },
        first_seen_height: Number(r.first_seen_height),
        first_seen_at: r.first_seen_at.toISOString(),
        last_updated_height: Number(r.last_updated_height),
        last_updated_at: r.last_updated_at.toISOString(),
        dapps_count: Number(r.dapps_count),
      })),
    };
  });

  app.get<{ Querystring: { limit?: string; action?: string } }>(
    '/dapps/calls',
    async (req, reply) => {
      const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
      const params: (string | number)[] = [];
      let where = '';
      if (req.query.action !== undefined) {
        const a = Number(req.query.action);
        if (Number.isFinite(a)) {
          params.push(a);
          where = `WHERE action = $${params.length}`;
        }
      }
      params.push(limit);

      const { rows } = await q<RawCallRow>(
        `SELECT kernel_id, call_index, height::text, block_ts, action, args, confirmed
           FROM dapp_store_raw_calls
           ${where}
          ORDER BY height DESC, call_index ASC
          LIMIT $${params.length}`,
        params,
      );

      void reply.header('cache-control', 'public, max-age=30');
      return {
        calls: rows.map((r) => ({
          kernel_id: r.kernel_id,
          call_index: r.call_index,
          height: Number(r.height),
          block_ts: r.block_ts.toISOString(),
          action: r.action,
          args: r.args,
          confirmed: r.confirmed,
        })),
      };
    },
  );
}
