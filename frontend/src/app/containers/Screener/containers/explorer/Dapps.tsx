import React, { useCallback, useEffect, useState } from 'react';
import { styled } from '@linaria/react';
import {
  Page, Card, ExplorerHeader, H1, H2, H3, Subtitle, Muted, TabBtn,
  Pill, DataTable, ScrollX, ErrorBox, theme,
} from './shared';
import { api } from '../../api/client';
import type {
  ApiDapp,
  ApiDappPublisher,
  ApiDappRawCall,
} from '../../api/types';

// ---------------------------------------------------------------------------
// /dapps — directory of dapps published to the BEAM DApp Store registry
// contract. Backed by `/api/dapps`, `/api/dapps/publishers`, `/api/dapps/calls`.
//
// While the projection layer is still maturing in the indexer, the "Calls"
// tab is the canonical view: it shows the raw on-chain rows we've captured
// for the DApp Store CID without trying to interpret them.
// ---------------------------------------------------------------------------

const REFRESH_MS = 60_000;

type Tab = 'dapps' | 'publishers' | 'calls';

const Toolbar = styled.div`
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin: 8px 0 12px;
`;

const Mono = styled.span`
  font-family: monospace;
  word-break: break-all;
`;

const Card2 = styled.div`
  background: ${theme.color.surface2};
  border: 1px solid ${theme.color.borderDim};
  border-radius: ${theme.radius.md};
  padding: 10px 14px;
  display: flex;
  gap: 12px;
  align-items: center;
  margin-bottom: 10px;
`;

const Icon = styled.div`
  width: 36px;
  height: 36px;
  border-radius: 8px;
  background: ${theme.color.surface};
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 36px;
  overflow: hidden;
  img { width: 100%; height: 100%; object-fit: contain; }
`;

const Pre = styled.pre`
  white-space: pre-wrap;
  word-break: break-all;
  font-size: 11px;
  background: ${theme.color.surface2};
  border: 1px solid ${theme.color.borderDim};
  border-radius: 6px;
  padding: 8px;
  margin: 0;
  max-height: 240px;
  overflow: auto;
`;

const ActionLabel: Record<number, string> = {
  0: 'CreatePublisher',
  1: 'UpdatePublisher',
  2: 'UploadDApp',
  3: 'DeleteDApp',
};

function fmtRelative(iso: string): string {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return '—';
  const delta = Math.round((Date.now() - ts) / 1000);
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.round(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.round(delta / 3600)}h ago`;
  return `${Math.round(delta / 86400)}d ago`;
}

function short(s: string | null | undefined, n = 16): string {
  if (!s) return '—';
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// Publisher-supplied URLs land here straight from on-chain state — anyone can
// register as a publisher and put anything in these fields. Reject every
// scheme except http(s) so a malicious publisher can't ship a `javascript:`
// payload via the directory.
function safeHttpUrl(u: string | null | undefined): string | undefined {
  if (!u) return undefined;
  try {
    const parsed = new URL(u, window.location.origin);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.toString();
    }
  } catch { /* fall through */ }
  return undefined;
}

// For dapp icons we accept three shapes:
//   - http(s) URL              — same rules as the publisher links above.
//   - base64 (no scheme)       — what the BEAM DApp Store shader emits today.
//   - data:image/(png|jpeg|gif|webp);base64,…  — explicit data URI.
// We deliberately reject data:image/svg+xml — SVG can carry inline scripts.
const RAW_BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const DATA_URI_RE = /^data:image\/(png|jpeg|jpg|gif|webp);base64,([A-Za-z0-9+/=]+)$/i;

function safeIconSrc(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  // http(s) → reuse the URL validator.
  const httpish = safeHttpUrl(raw);
  if (httpish) return httpish;
  // Explicit data URI? Reject svg, accept the allowlisted raster formats.
  const m = raw.match(DATA_URI_RE);
  if (m) return `data:image/${m[1].toLowerCase()};base64,${m[2]}`;
  // Bare base64 → assume it's a small PNG (the historical shape).
  if (raw.length > 16 && raw.length < 200_000 && RAW_BASE64_RE.test(raw)) {
    return `data:image/png;base64,${raw}`;
  }
  return undefined;
}

export const Dapps: React.FC = () => {
  const [tab, setTab] = useState<Tab>('dapps');
  const [dapps, setDapps] = useState<ApiDapp[] | null>(null);
  const [publishers, setPublishers] = useState<ApiDappPublisher[] | null>(null);
  const [calls, setCalls] = useState<ApiDappRawCall[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      // Tabs share the same backing tables, so prefetch all three (cheap).
      const [d, p, c] = await Promise.all([
        api.dapps(),
        api.dappPublishers(),
        api.dappRawCalls({ limit: 100 }),
      ]);
      setDapps(d.dapps);
      setPublishers(p.publishers);
      setCalls(c.calls);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => { void refresh(); }, REFRESH_MS);
    return () => clearInterval(id);
  }, [refresh]);

  return (
    <Page>
      <ExplorerHeader>
        <div>
          <H1>DApp Store</H1>
          <Subtitle>Public directory of dapps registered on the BEAM DApp Store contract.</Subtitle>
        </div>
      </ExplorerHeader>

      <Card>
        <Toolbar>
          <TabBtn type="button" data-active={tab === 'dapps'}      onClick={() => setTab('dapps')}>Dapps {dapps ? `(${dapps.length})` : ''}</TabBtn>
          <TabBtn type="button" data-active={tab === 'publishers'} onClick={() => setTab('publishers')}>Publishers {publishers ? `(${publishers.length})` : ''}</TabBtn>
          <TabBtn type="button" data-active={tab === 'calls'}      onClick={() => setTab('calls')}>Raw calls</TabBtn>
        </Toolbar>
        {err ? <ErrorBox>{err}</ErrorBox> : null}

        {tab === 'dapps' && (
          dapps === null ? <Muted>Loading…</Muted>
            : dapps.length === 0 ? (
              <Muted>
                No projected dapps yet. The indexer's raw-calls table is the source of truth while the
                projection layer is being refined — see the <strong>Raw calls</strong> tab.
              </Muted>
            ) : (
              <>
                {dapps.map((d) => (
                  <Card2 key={d.id}>
                    <Icon>{safeIconSrc(d.icon) ? <img src={safeIconSrc(d.icon)} alt="" /> : '🧩'}</Icon>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <H3 style={{ margin: 0 }}>{d.name ?? `Dapp ${short(d.id, 10)}`}</H3>
                      <Muted style={{ margin: '2px 0' }}>{d.description ?? '—'}</Muted>
                      <Muted style={{ margin: 0, fontSize: 11 }}>
                        Publisher <Mono>{short(d.publisher.name ?? d.publisher.pubkey, 20)}</Mono>
                        {' · '}
                        v{d.version ?? '—'}
                        {' · '}
                        height {d.last_updated_height} ({fmtRelative(d.last_updated_at)})
                        {d.deleted_at ? <> {' · '} <Pill data-tone="danger">deleted</Pill></> : null}
                      </Muted>
                    </div>
                  </Card2>
                ))}
              </>
            )
        )}

        {tab === 'publishers' && (
          publishers === null ? <Muted>Loading…</Muted>
            : publishers.length === 0 ? <Muted>No publishers projected yet (see Raw calls).</Muted>
              : (
                <ScrollX>
                  <DataTable>
                    <thead>
                      <tr>
                        <th>Publisher</th>
                        <th>Pubkey</th>
                        <th>Dapps</th>
                        <th>First seen</th>
                        <th>Updated</th>
                        <th>Links</th>
                      </tr>
                    </thead>
                    <tbody>
                      {publishers.map((p) => (
                        <tr key={p.pubkey}>
                          <td>{p.name ?? '—'}</td>
                          <td className="mono">{short(p.pubkey, 16)}</td>
                          <td className="mono">{p.dapps_count}</td>
                          <td>{fmtRelative(p.first_seen_at)}</td>
                          <td>{fmtRelative(p.last_updated_at)}</td>
                          <td>
                            {safeHttpUrl(p.website)        ? <a href={safeHttpUrl(p.website)}        target="_blank" rel="noreferrer noopener">site </a> : null}
                            {safeHttpUrl(p.social.twitter) ? <a href={safeHttpUrl(p.social.twitter)} target="_blank" rel="noreferrer noopener">x </a>    : null}
                            {safeHttpUrl(p.social.telegram)? <a href={safeHttpUrl(p.social.telegram)}target="_blank" rel="noreferrer noopener">tg </a>   : null}
                            {safeHttpUrl(p.social.discord) ? <a href={safeHttpUrl(p.social.discord)} target="_blank" rel="noreferrer noopener">dc </a>   : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </DataTable>
                </ScrollX>
              )
        )}

        {tab === 'calls' && (
          calls === null ? <Muted>Loading…</Muted>
            : calls.length === 0 ? <Muted>No raw calls captured yet — the indexer ingests the DApp Store CID every 10 min.</Muted>
              : (
                <>
                  {calls.map((c) => (
                    <Card2 key={`${c.kernel_id}-${c.call_index}`} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                        <Pill data-tone={c.action == null ? undefined : 'info'}>
                          {c.action == null ? '—' : (ActionLabel[c.action] ?? `#${c.action}`)}
                        </Pill>
                        <Muted style={{ margin: 0, fontSize: 11 }}>
                          height {c.height} · {fmtRelative(c.block_ts)} · kernel <Mono>{short(c.kernel_id, 14)}</Mono>
                          {' · '}
                          {c.confirmed ? <Pill data-tone="success">confirmed</Pill> : <Pill data-tone="info">pending</Pill>}
                        </Muted>
                      </div>
                      <Pre>{JSON.stringify(c.args, null, 2)}</Pre>
                    </Card2>
                  ))}
                </>
              )
        )}
      </Card>

      <Card>
        <H2>About the BEAM DApp Store</H2>
        <Muted>
          The DApp Store is a single on-chain contract (mainnet CID <Mono>e2d24b…2af41c</Mono>) that
          tracks publishers and their published dapps. The wallet ships a local app-shader
          (<code>dapps_store_app.wasm</code>) that wraps every call to the contract. We index those
          calls into <code>dapp_store_raw_calls</code> and project them into the publisher / dapp
          views shown above. While the projection layer is incomplete the raw-calls view is the
          authoritative source — and every refinement to the parser projects the existing rows
          without needing to re-fetch from the chain.
        </Muted>
      </Card>
    </Page>
  );
};

export default Dapps;
