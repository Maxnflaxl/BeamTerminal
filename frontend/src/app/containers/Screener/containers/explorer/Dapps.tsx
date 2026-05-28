import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { styled } from '@linaria/react';
import {
  Page, Card, ExplorerHeader, H1, H2, H3, Subtitle, Muted, TabBtn,
  Pill, DataTable, ScrollX, ErrorBox, theme,
} from './shared';
import { api } from '../../api/client';
import type {
  ApiDapp,
  ApiDappDetail,
  ApiDappPublisher,
  ApiDappVersion,
} from '../../api/types';
import CopyIcon from './shared/icons/copy.svg';
import TwitterIcon from './shared/icons/social-twitter.svg';
import TelegramIcon from './shared/icons/social-telegram.svg';
import DiscordIcon from './shared/icons/social-discord.svg';
import LinkedinIcon from './shared/icons/social-linkedin.svg';
import InstagramIcon from './shared/icons/social-instagram.svg';
import WebsiteIcon from './shared/icons/social-website.svg';

// ---------------------------------------------------------------------------
// /dapps — directory of dapps published to the BEAM DApp Store registry
// contract. Backed by `/api/dapps`, `/api/dapps/publishers`, `/api/dapps/:id`.
//
// First-seen / last-updated timestamps for publishers and dapps are mined
// from the explorer's /contract calls-history (see backend services/dappStore
// .ts → syncDappStoreCalls). The contract is upgradable2, so we can identify
// the publisher (from the call's blob arg) but not the individual dapp;
// per-dapp dates fall back to the publisher's add_dapp/update_dapp range.
// ---------------------------------------------------------------------------

const REFRESH_MS = 60_000;

type Tab = 'dapps' | 'publishers';

// Category enum mirrors beam-ui apps_view.h
const CATEGORY_LABEL: Record<number, string> = {
  0: 'Undefined',
  1: 'Other',
  2: 'Finance',
  3: 'Games',
  4: 'Technology',
  5: 'Governance',
};

const ACTION_LABEL: Record<number, string> = {
  0: 'CreatePublisher',
  1: 'UpdatePublisher',
  2: 'UploadDApp',
  3: 'DeleteDApp',
};

// ---------------------------------------------------------------------------
// styled bits
// ---------------------------------------------------------------------------

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

const DappGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 10px;
`;

const DappCard = styled.button`
  background: ${theme.color.surface2};
  border: 1px solid ${theme.color.borderDim};
  border-radius: ${theme.radius.md};
  padding: 12px 14px;
  display: flex;
  gap: 12px;
  align-items: flex-start;
  text-align: left;
  font: inherit;
  font-family: ${theme.font.mono};
  color: ${theme.color.text};
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
  &:hover { border-color: ${theme.color.accent}; background: rgba(0, 246, 210, 0.04); }
`;

const Icon48 = styled.div`
  width: 48px;
  height: 48px;
  border-radius: 10px;
  background: ${theme.color.surface};
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 48px;
  overflow: hidden;
  font-size: 22px;
  line-height: 1;
  img { width: 100%; height: 100%; object-fit: contain; }
`;

const Icon32 = styled.div`
  width: 32px;
  height: 32px;
  border-radius: 8px;
  background: ${theme.color.surface};
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 32px;
  overflow: hidden;
  font-size: 16px;
  line-height: 1;
  img { width: 100%; height: 100%; object-fit: contain; }
`;

const CardBody = styled.div`
  flex: 1;
  min-width: 0;
`;

const CardName = styled.div`
  font-size: 14px;
  font-weight: 600;
  color: ${theme.color.text};
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const CardDesc = styled.div`
  font-size: 11px;
  color: ${theme.color.muted};
  margin-top: 2px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
`;

const CardMeta = styled.div`
  font-size: 10px;
  color: ${theme.color.muted};
  margin-top: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px 10px;
  align-items: center;
`;

const PublisherChip = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: rgba(255, 255, 255, 0.06);
  border-radius: 4px;
  padding: 2px 6px;
  font-size: 10px;
  color: ${theme.color.text};
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const IconButton = styled.button`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: 1px solid ${theme.color.border};
  border-radius: 4px;
  color: ${theme.color.muted};
  cursor: pointer;
  padding: 3px 6px;
  font: inherit;
  transition: color 0.15s, border-color 0.15s;
  svg { width: 12px; height: 12px; }
  &:hover { color: ${theme.color.accent}; border-color: ${theme.color.accent}; }
`;

const SocialLink = styled.a`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  color: ${theme.color.muted};
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid ${theme.color.borderDim};
  transition: color 0.15s, border-color 0.15s, background 0.15s;
  svg { width: 14px; height: 14px; }
  &:hover { color: ${theme.color.accent}; border-color: ${theme.color.accent}; background: rgba(0, 246, 210, 0.06); }
`;

const KeyRow = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
`;

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

const ModalBackdrop = styled.div`
  position: fixed;
  inset: 0;
  background: rgba(2, 16, 31, 0.75);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  z-index: 200;
`;

const ModalShell = styled.div`
  background: ${theme.color.bg};
  border: 1px solid ${theme.color.border};
  border-radius: ${theme.radius.lg};
  width: 100%;
  max-width: 720px;
  max-height: calc(100vh - 64px);
  display: flex;
  flex-direction: column;
  position: relative;
  color: ${theme.color.text};
  font-family: ${theme.font.mono};
`;

const ModalHeader = styled.div`
  display: flex;
  gap: 14px;
  align-items: center;
  padding: 16px 20px 12px;
  border-bottom: 1px solid ${theme.color.divider};
`;

const ModalBody = styled.div`
  padding: 16px 20px;
  overflow: auto;
  flex: 1;
`;

const ModalClose = styled.button`
  position: absolute;
  top: 12px;
  right: 12px;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 1px solid ${theme.color.border};
  background: ${theme.color.surface};
  color: ${theme.color.text};
  cursor: pointer;
  font: inherit;
  line-height: 1;
  &:hover { color: ${theme.color.accent}; border-color: ${theme.color.accent}; }
`;

const Field = styled.div`
  margin-bottom: 12px;
  font-size: 12px;
`;

const FieldLabel = styled.div`
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: ${theme.color.muted};
  margin-bottom: 3px;
`;

const Toast = styled.div`
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  background: ${theme.color.surface};
  border: 1px solid ${theme.color.accent};
  color: ${theme.color.accent};
  padding: 8px 14px;
  border-radius: ${theme.radius.md};
  font-size: 12px;
  z-index: 300;
  pointer-events: none;
  font-family: ${theme.font.mono};
`;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// Multi-unit relative time. For older entries we want "2y 2m 3d ago" rather
// than "1234d ago" — the longer something has been around the more useful the
// composite breakdown is.
//
// "Months" here are 30 days, "years" 365 — fine for display: we never claim
// a precise calendar duration, and the trailing units (e.g. "3d") let the
// user spot rough age. We show up to two non-zero units, biggest first.
function fmtRelative(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return null;
  let s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;

  const Y = 365 * 24 * 3600;
  const M = 30  * 24 * 3600;
  const D = 24 * 3600;
  const H = 3600;
  const MIN = 60;
  const parts: string[] = [];
  const take = (size: number, suf: string) => {
    const n = Math.floor(s / size);
    if (n > 0) { parts.push(`${n}${suf}`); s -= n * size; }
  };
  take(Y, 'y');
  take(M, 'mo');
  // No years/months → fall through to days/hours/minutes.
  take(D, 'd');
  take(H, 'h');
  take(MIN, 'm');
  // Keep at most two units (biggest first) so older entries read like
  // "2y 2mo" and recent ones like "3h 12m". Single-unit ("4d") is fine too.
  return parts.slice(0, 2).join(' ') + ' ago';
}

function fmtAbsolute(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

// Explanation shown on hover when a per-dapp first_seen is null. The
// contract stores `m_Timestamp` on every dapp record (set on add + every
// update), so `last_updated_at` is always known — but the contract overwrites
// that timestamp on each update, so it doesn't preserve the original add
// height. To recover first_seen we'd need to attribute add_dapp calls to
// specific dapps, and the upgradable2 wrapper drops the inner args from the
// explorer feed. We only fill first_seen when the mapping is unambiguous —
// a publisher with exactly one current dapp and one add_dapp call.
const UNKNOWN_TOOLTIP =
  "Original add-date unknown — this publisher has more than one dapp, and the "
  + "DApp Store contract is wrapped by upgradable2 so the explorer can't "
  + "decode which add_dapp call refers to which dapp. (Last-updated is "
  + "always known: the contract stamps it on the dapp record itself.)";

const Unknown: React.FC<{ reason?: string }> = ({ reason = UNKNOWN_TOOLTIP }) => (
  <span style={{ color: 'rgba(255,255,255,0.4)', borderBottom: '1px dashed rgba(255,255,255,0.25)', cursor: 'help' }} title={reason}>
    unknown
  </span>
);

// Inline "x ago" used in card meta / table cells. Falls back to a hoverable
// "unknown" so the UI never silently lies about an on-chain date.
const RelDate: React.FC<{ iso: string | null; reason?: string }> = ({ iso, reason }) => {
  const rel = fmtRelative(iso);
  return rel != null ? <>{rel}</> : <Unknown reason={reason} />;
};

// Two-line absolute+relative date block used inside the modals.
const DateBlock: React.FC<{ iso: string | null; height: number | null; reason?: string }> = ({ iso, height, reason }) => {
  const abs = fmtAbsolute(iso);
  if (abs == null) return <Unknown reason={reason} />;
  return (
    <>
      <div>{abs}</div>
      <Muted style={{ margin: '2px 0 0', fontSize: 10 }}>
        height {height ?? '—'} · {fmtRelative(iso)}
      </Muted>
    </>
  );
};

function shortKey(s: string | null | undefined, head = 8, tail = 6): string {
  if (!s) return '—';
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

// Publisher-supplied URLs land here straight from on-chain state — anyone can
// register as a publisher and put anything in these fields. We:
//   1. Reject every scheme except http(s) (no `javascript:`, `data:`, etc.).
//   2. Normalize schemeless inputs like "example.com" to "https://example.com"
//      — previously we resolved them via `new URL(u, window.location.origin)`,
//      which produced a same-origin URL ("https://<our-host>/example.com"),
//      and clicks ended up react-router-navigating inside the SPA instead of
//      opening the external site.
const KNOWN_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const HTTPS_SCHEME_RE = /^https?:\/\//i;

function safeHttpUrl(u: string | null | undefined): string | undefined {
  if (!u) return undefined;
  const s = u.trim();
  if (!s) return undefined;
  let candidate: string;
  if (HTTPS_SCHEME_RE.test(s)) {
    candidate = s;
  } else if (KNOWN_SCHEME_RE.test(s)) {
    // Has a scheme but it isn't http(s) — reject (javascript:, data:, mailto:, …).
    return undefined;
  } else {
    candidate = `https://${s}`;
  }
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    if (!parsed.hostname) return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
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
  const httpish = safeHttpUrl(raw);
  if (httpish) return httpish;
  const m = raw.match(DATA_URI_RE);
  if (m) return `data:image/${m[1].toLowerCase()};base64,${m[2]}`;
  if (raw.length > 16 && raw.length < 200_000 && RAW_BASE64_RE.test(raw)) {
    return `data:image/png;base64,${raw}`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// re-usable subcomponents
// ---------------------------------------------------------------------------

const DappIcon: React.FC<{ icon: string | null; size?: 'sm' | 'md' }> = ({ icon, size = 'md' }) => {
  const src = safeIconSrc(icon);
  const Wrapper = size === 'sm' ? Icon32 : Icon48;
  return <Wrapper>{src ? <img src={src} alt="" loading="lazy" /> : <span aria-hidden>🧩</span>}</Wrapper>;
};

const CopyKey: React.FC<{ value: string; onCopy: (msg: string) => void; show?: 'full' | 'short' }> = ({ value, onCopy, show = 'short' }) => (
  <KeyRow>
    <Mono style={{ fontSize: 11 }}>{show === 'full' ? value : shortKey(value)}</Mono>
    <IconButton
      type="button"
      title="Copy publisher key"
      aria-label="Copy publisher key"
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard?.writeText(value).then(
          () => onCopy('Publisher key copied'),
          () => onCopy('Copy failed'),
        );
      }}
    >
      <CopyIcon />
    </IconButton>
  </KeyRow>
);

const SocialLinks: React.FC<{ social: ApiDappPublisher['social']; website: string | null }> = ({ social, website }) => {
  const links: Array<{ key: string; href: string; label: string; Icon: React.FC<React.SVGProps<SVGSVGElement>> }> = [];
  if (safeHttpUrl(website))           links.push({ key: 'site',  href: safeHttpUrl(website)!,           label: 'Website',  Icon: WebsiteIcon });
  if (safeHttpUrl(social.twitter))    links.push({ key: 'x',     href: safeHttpUrl(social.twitter)!,    label: 'X / Twitter', Icon: TwitterIcon });
  if (safeHttpUrl(social.telegram))   links.push({ key: 'tg',    href: safeHttpUrl(social.telegram)!,   label: 'Telegram', Icon: TelegramIcon });
  if (safeHttpUrl(social.discord))    links.push({ key: 'dc',    href: safeHttpUrl(social.discord)!,    label: 'Discord',  Icon: DiscordIcon });
  if (safeHttpUrl(social.linkedin))   links.push({ key: 'li',    href: safeHttpUrl(social.linkedin)!,   label: 'LinkedIn', Icon: LinkedinIcon });
  if (safeHttpUrl(social.instagram))  links.push({ key: 'ig',    href: safeHttpUrl(social.instagram)!,  label: 'Instagram', Icon: InstagramIcon });
  if (links.length === 0) return <Muted style={{ margin: 0 }}>No social links.</Muted>;
  return (
    // Stop propagation here so the link click doesn't bubble to a parent
    // <tr>/Card with its own onClick (which would open the modal *and* try to
    // navigate, leaving the user on the pairs list).
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }} onClick={(e) => e.stopPropagation()}>
      {links.map(({ key, href, label, Icon }) => (
        <SocialLink key={key} href={href} target="_blank" rel="noreferrer noopener" title={label} aria-label={label}>
          <Icon />
        </SocialLink>
      ))}
    </div>
  );
};


// ---------------------------------------------------------------------------
// Publisher modal
// ---------------------------------------------------------------------------

const PublisherModal: React.FC<{
  publisher: ApiDappPublisher;
  dapps: ApiDapp[];
  onClose: () => void;
  onCopy: (msg: string) => void;
  onPickDapp: (d: ApiDapp) => void;
}> = ({ publisher, dapps, onClose, onCopy, onPickDapp }) => {
  const own = dapps.filter((d) => d.publisher.pubkey === publisher.pubkey);
  return (
    <ModalBackdrop onClick={onClose}>
      <ModalShell onClick={(e) => e.stopPropagation()}>
        <ModalClose type="button" onClick={onClose} aria-label="Close">×</ModalClose>
        <ModalHeader>
          <div style={{ flex: 1, minWidth: 0 }}>
            <H1 style={{ fontSize: 18 }}>{publisher.name ?? 'Unnamed publisher'}</H1>
            {publisher.short_title ? <Subtitle>{publisher.short_title}</Subtitle> : null}
          </div>
        </ModalHeader>
        <ModalBody>
          {publisher.about_me ? (
            <Field>
              <FieldLabel>About</FieldLabel>
              <div style={{ whiteSpace: 'pre-wrap' }}>{publisher.about_me}</div>
            </Field>
          ) : null}

          <Field>
            <FieldLabel>Publisher key</FieldLabel>
            <CopyKey value={publisher.pubkey} onCopy={onCopy} show="full" />
          </Field>

          <Field>
            <FieldLabel>Links</FieldLabel>
            <SocialLinks social={publisher.social} website={publisher.website} />
          </Field>

          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
            <Field>
              <FieldLabel>First seen</FieldLabel>
              <DateBlock
                iso={publisher.first_seen_at}
                height={publisher.first_seen_height}
                reason="No DApp Store calls have been observed from this publisher yet."
              />
            </Field>
            <Field>
              <FieldLabel>Last updated</FieldLabel>
              <DateBlock
                iso={publisher.last_updated_at}
                height={publisher.last_updated_height}
                reason="No DApp Store calls have been observed from this publisher yet."
              />
            </Field>
            <Field>
              <FieldLabel>Dapps</FieldLabel>
              <div>{publisher.dapps_count}</div>
            </Field>
          </div>

          <H3>Published dapps</H3>
          {own.length === 0 ? (
            <Muted>This publisher has no dapps listed.</Muted>
          ) : (
            <ScrollX>
              <DataTable>
                <thead>
                  <tr>
                    <th></th>
                    <th>Name</th>
                    <th>Category</th>
                    <th>Version</th>
                    <th>Last updated</th>
                  </tr>
                </thead>
                <tbody>
                  {own.map((d) => (
                    <tr
                      key={d.id}
                      onClick={() => onPickDapp(d)}
                      style={{ cursor: 'pointer' }}
                    >
                      <td><DappIcon icon={d.icon} size="sm" /></td>
                      <td>
                        {d.name ?? <Mono>{shortKey(d.id)}</Mono>}
                        {d.deleted_at ? <> {' '}<Pill data-tone="danger">deleted</Pill></> : null}
                      </td>
                      <td className="muted">{d.category != null ? (CATEGORY_LABEL[d.category] ?? `#${d.category}`) : '—'}</td>
                      <td className="mono">v{d.version ?? '—'}</td>
                      <td><RelDate iso={d.last_updated_at} /></td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
            </ScrollX>
          )}
        </ModalBody>
      </ModalShell>
    </ModalBackdrop>
  );
};

// ---------------------------------------------------------------------------
// Dapp modal
// ---------------------------------------------------------------------------

const DappModal: React.FC<{
  dapp: ApiDapp;
  detail: ApiDappDetail | null;
  loading: boolean;
  err: string | null;
  onClose: () => void;
  onCopy: (msg: string) => void;
  onPickPublisher: (pubkey: string) => void;
}> = ({ dapp, detail, loading, err, onClose, onCopy, onPickPublisher }) => {
  // De-duplicate version rows when the projection sentinel (height=0,
  // action=2) is the only record we have — show the *current* row only.
  const versions: ApiDappVersion[] = useMemo(() => {
    if (!detail || detail.versions.length === 0) return [];
    return [...detail.versions].sort((a, b) => b.height - a.height || b.action - a.action);
  }, [detail]);

  return (
    <ModalBackdrop onClick={onClose}>
      <ModalShell onClick={(e) => e.stopPropagation()}>
        <ModalClose type="button" onClick={onClose} aria-label="Close">×</ModalClose>
        <ModalHeader>
          <DappIcon icon={dapp.icon} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <H1 style={{ fontSize: 18 }}>{dapp.name ?? 'Untitled dapp'}</H1>
            <Subtitle>
              v{dapp.version ?? '—'}
              {dapp.category != null ? <> · {CATEGORY_LABEL[dapp.category] ?? `#${dapp.category}`}</> : null}
              {dapp.deleted_at ? <> · <Pill data-tone="danger">deleted</Pill></> : null}
            </Subtitle>
          </div>
        </ModalHeader>
        <ModalBody>
          {err ? <ErrorBox>{err}</ErrorBox> : null}

          {dapp.description ? (
            <Field>
              <FieldLabel>Description</FieldLabel>
              <div style={{ whiteSpace: 'pre-wrap' }}>{dapp.description}</div>
            </Field>
          ) : null}

          <Field>
            <FieldLabel>Publisher</FieldLabel>
            <KeyRow>
              <button
                type="button"
                onClick={() => onPickPublisher(dapp.publisher.pubkey)}
                style={{
                  background: 'rgba(0, 246, 210, 0.08)',
                  border: '1px solid rgba(0, 246, 210, 0.4)',
                  color: '#00f6d2',
                  padding: '3px 10px',
                  borderRadius: 4,
                  font: 'inherit',
                  cursor: 'pointer',
                }}
              >
                {dapp.publisher.name ?? shortKey(dapp.publisher.pubkey)}
              </button>
              <CopyKey value={dapp.publisher.pubkey} onCopy={onCopy} />
            </KeyRow>
          </Field>

          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
            <Field>
              <FieldLabel>First seen</FieldLabel>
              <DateBlock iso={dapp.first_seen_at} height={dapp.first_seen_height} />
            </Field>
            <Field>
              <FieldLabel>Last updated</FieldLabel>
              <DateBlock iso={dapp.last_updated_at} height={dapp.last_updated_height} />
            </Field>
            <Field>
              <FieldLabel>API version</FieldLabel>
              <Mono>{dapp.api_version ?? '—'}</Mono>
              <Muted style={{ margin: '2px 0 0', fontSize: 10 }}>min: {dapp.min_api_version ?? '—'}</Muted>
            </Field>
          </div>

          {dapp.ipfs_id ? (
            <Field>
              <FieldLabel>IPFS CID</FieldLabel>
              <Mono style={{ fontSize: 11 }}>{dapp.ipfs_id}</Mono>
            </Field>
          ) : null}

          <H3>Version history</H3>
          {loading ? <Muted>Loading…</Muted> : versions.length === 0 ? (
            <Muted>
              No version history captured yet. The projection layer currently sees only the
              current version — older versions are mined incrementally as the indexer ingests
              new calls.
            </Muted>
          ) : (
            <ScrollX>
              <DataTable>
                <thead>
                  <tr>
                    <th>Version</th>
                    <th>Action</th>
                    <th>Height</th>
                    <th>Date</th>
                    <th>IPFS</th>
                  </tr>
                </thead>
                <tbody>
                  {versions.map((v, i) => (
                    <tr key={`${v.height}-${v.action}-${i}`}>
                      <td className="mono">v{v.version ?? '—'}</td>
                      <td>
                        <Pill data-tone={v.action === 3 ? 'danger' : 'info'}>
                          {ACTION_LABEL[v.action] ?? `#${v.action}`}
                        </Pill>
                      </td>
                      <td className="mono">{v.height || '—'}</td>
                      <td>{
                        // The append-only projector inserts a sentinel row with height=0
                        // for the current version when no real call attribution exists.
                        // Show the dapp's last_updated date instead (RelDate handles null).
                        v.height === 0
                          ? <RelDate iso={dapp.last_updated_at} />
                          : <RelDate iso={v.block_ts} />
                      }</td>
                      <td className="mono">{v.ipfs_hash ? shortKey(v.ipfs_hash) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
            </ScrollX>
          )}
        </ModalBody>
      </ModalShell>
    </ModalBackdrop>
  );
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export const Dapps: React.FC = () => {
  const [tab, setTab] = useState<Tab>('dapps');
  const [dapps, setDapps] = useState<ApiDapp[] | null>(null);
  const [publishers, setPublishers] = useState<ApiDappPublisher[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Modal state
  const [openDapp, setOpenDapp] = useState<ApiDapp | null>(null);
  const [openDappDetail, setOpenDappDetail] = useState<ApiDappDetail | null>(null);
  const [dappDetailLoading, setDappDetailLoading] = useState(false);
  const [dappDetailErr, setDappDetailErr] = useState<string | null>(null);
  const [openPublisher, setOpenPublisher] = useState<ApiDappPublisher | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((cur) => (cur === msg ? null : cur)), 1800);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [d, p] = await Promise.all([api.dapps(), api.dappPublishers()]);
      setDapps(d.dapps);
      setPublishers(p.publishers);
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

  // Load version history lazily when a dapp modal opens.
  useEffect(() => {
    if (!openDapp) {
      setOpenDappDetail(null);
      setDappDetailErr(null);
      return;
    }
    let cancelled = false;
    setDappDetailLoading(true);
    setDappDetailErr(null);
    api.dapp(openDapp.id).then(
      (d) => { if (!cancelled) { setOpenDappDetail(d); setDappDetailLoading(false); } },
      (e) => { if (!cancelled) {
        setDappDetailErr(e instanceof Error ? e.message : String(e));
        setDappDetailLoading(false);
      } },
    );
    return () => { cancelled = true; };
  }, [openDapp]);

  // ESC closes whichever modal is open (dapp wins over publisher).
  useEffect(() => {
    if (!openDapp && !openPublisher) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (openDapp) setOpenDapp(null);
      else setOpenPublisher(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openDapp, openPublisher]);

  const publishersByKey = useMemo(() => {
    const m = new Map<string, ApiDappPublisher>();
    for (const p of publishers ?? []) m.set(p.pubkey, p);
    return m;
  }, [publishers]);

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
        </Toolbar>
        {err ? <ErrorBox>{err}</ErrorBox> : null}

        {tab === 'dapps' && (
          dapps === null ? <Muted>Loading…</Muted>
            : dapps.length === 0 ? <Muted>No dapps registered yet.</Muted>
              : (
                <DappGrid>
                  {dapps.map((d) => (
                    <DappCard key={d.id} type="button" onClick={() => setOpenDapp(d)}>
                      <DappIcon icon={d.icon} />
                      <CardBody>
                        <CardName>{d.name ?? `Dapp ${shortKey(d.id)}`}</CardName>
                        <CardDesc>{d.description ?? ' '}</CardDesc>
                        <CardMeta>
                          <PublisherChip
                            onClick={(e) => {
                              e.stopPropagation();
                              const p = publishersByKey.get(d.publisher.pubkey);
                              if (p) setOpenPublisher(p);
                            }}
                            style={{ cursor: 'pointer' }}
                          >
                            {d.publisher.name ?? shortKey(d.publisher.pubkey)}
                          </PublisherChip>
                          <span>v{d.version ?? '—'}</span>
                          {d.category != null ? <span>· {CATEGORY_LABEL[d.category] ?? `#${d.category}`}</span> : null}
                          <span>· <RelDate iso={d.last_updated_at} /></span>
                          {d.deleted_at ? <Pill data-tone="danger">deleted</Pill> : null}
                        </CardMeta>
                      </CardBody>
                    </DappCard>
                  ))}
                </DappGrid>
              )
        )}

        {tab === 'publishers' && (
          publishers === null ? <Muted>Loading…</Muted>
            : publishers.length === 0 ? <Muted>No publishers registered yet.</Muted>
              : (
                <ScrollX>
                  <DataTable>
                    <thead>
                      <tr>
                        <th>Publisher</th>
                        <th>Key</th>
                        <th>Dapps</th>
                        <th>First seen</th>
                        <th>Updated</th>
                        <th>Links</th>
                      </tr>
                    </thead>
                    <tbody>
                      {publishers.map((p) => (
                        <tr
                          key={p.pubkey}
                          onClick={() => setOpenPublisher(p)}
                          style={{ cursor: 'pointer' }}
                        >
                          <td>{p.name ?? '—'}</td>
                          <td><CopyKey value={p.pubkey} onCopy={showToast} /></td>
                          <td className="mono">{p.dapps_count}</td>
                          <td><RelDate iso={p.first_seen_at} reason="No DApp Store calls have been observed from this publisher yet." /></td>
                          <td><RelDate iso={p.last_updated_at} reason="No DApp Store calls have been observed from this publisher yet." /></td>
                          <td><SocialLinks social={p.social} website={p.website} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </DataTable>
                </ScrollX>
              )
        )}
      </Card>

      <Card>
        <H2>About the BEAM DApp Store</H2>
        <Muted>
          The DApp Store is a single on-chain contract (mainnet CID <Mono>e2d24b…2af41c</Mono>) that
          tracks publishers and their published dapps. The wallet ships a local app-shader
          (<code>dapps_store_app.wasm</code>) that wraps every call to the contract. The indexer
          runs that shader server-side to read the current publisher / dapp tables, and mines the
          explorer's calls-history table to stamp each publisher with their real on-chain
          first-seen / last-updated heights.
        </Muted>
      </Card>

      {openDapp ? (
        <DappModal
          dapp={openDapp}
          detail={openDappDetail}
          loading={dappDetailLoading}
          err={dappDetailErr}
          onClose={() => setOpenDapp(null)}
          onCopy={showToast}
          onPickPublisher={(pubkey) => {
            const p = publishersByKey.get(pubkey);
            if (p) {
              setOpenDapp(null);
              setOpenPublisher(p);
            }
          }}
        />
      ) : openPublisher ? (
        <PublisherModal
          publisher={openPublisher}
          dapps={dapps ?? []}
          onClose={() => setOpenPublisher(null)}
          onCopy={showToast}
          onPickDapp={(d) => {
            setOpenPublisher(null);
            setOpenDapp(d);
          }}
        />
      ) : null}

      {toast ? <Toast>{toast}</Toast> : null}
    </Page>
  );
};

export default Dapps;
