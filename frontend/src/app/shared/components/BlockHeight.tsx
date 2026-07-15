import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { styled } from '@linaria/react';
import { Link } from 'react-router-dom';
import { ROUTES } from '../constants/routes';
import { EXPLORER_API } from '../constants';

// A block height rendered as an in-app link to the terminal's own Beam Smart
// Explorer block view (`/explorer/beam?type=block&height=N`, deep-linkable via
// its URL search params) plus an on-hover tooltip showing the block timestamp.
//
// The timestamp is fetched lazily — only once the user hovers — from the
// explorer `/block?height=` endpoint, and cached process-wide so a height is
// fetched at most once no matter how many rows render it. Callers that already
// know the timestamp (e.g. an asset's mint time) pass `ts` to skip the fetch;
// callers showing a future height pass `tip` so the tooltip shows an ETA
// instead of fetching a block that does not exist yet.

const DEFAULT_EXPLORER_API = EXPLORER_API;
const BLOCK_SECONDS = 60;

// Resolved fetch URL -> unix-seconds timestamp (null = looked up, unavailable).
const tsCache = new Map<string, number | null>();

export type BlockUrlResolver = (height: number) => string | null;

function defaultResolver(height: number): string {
  return `${DEFAULT_EXPLORER_API}/block?height=${height}`;
}

function fmtTs(ts: number): string {
  return new Date(ts * 1000).toLocaleString();
}

function fmtFutureEta(blocks: number): string {
  const sec = blocks * BLOCK_SECONDS;
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  if (days > 365) return `~${(days / 365).toFixed(1)}y from now`;
  if (days >= 1) return `~${days}d from now`;
  if (hours >= 1) return `~${hours}h from now`;
  return 'soon';
}

interface UseBlockTimestampOpts {
  enabled: boolean;
  resolveUrl?: BlockUrlResolver;
}

/** Lazily resolve a block's timestamp; only fetches while `enabled`. */
export function useBlockTimestamp(
  height: number | null | undefined,
  { enabled, resolveUrl }: UseBlockTimestampOpts,
): { ts: number | null; loading: boolean } {
  const resolverRef = useRef(resolveUrl);
  resolverRef.current = resolveUrl;
  const [ts, setTs] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // Clear loading on every non-fetching path. In particular, when `enabled`
    // flips to false (mouse leaves), this effect re-runs and must reset
    // loading — otherwise an in-flight fetch that gets cancelled here would
    // leave loading stuck at true (its .finally is skipped when cancelled),
    // and the next hover would show "Loading…" forever despite a cached value.
    if (!enabled || height === null || height === undefined) {
      setLoading(false);
      return undefined;
    }
    const resolve = resolverRef.current ?? defaultResolver;
    const url = resolve(height);
    if (!url) {
      setLoading(false);
      return undefined;
    }
    if (tsCache.has(url)) {
      setTs(tsCache.get(url) ?? null);
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    fetch(url)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: any) => {
        const t = typeof d?.timestamp === 'number' ? d.timestamp : null;
        tsCache.set(url, t);
        if (!cancelled) setTs(t);
      })
      .catch(() => {
        tsCache.set(url, null);
        if (!cancelled) setTs(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, height]);

  return { ts, loading };
}

const Wrap = styled.span`
  position: relative;
  display: inline-flex;
  align-items: center;
`;

const HeightLink = styled(Link)`
  color: inherit;
  text-decoration: none;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  &:hover {
    text-decoration: underline;
  }
`;

const Tip = styled.span`
  /* Rendered into <body> via a portal and positioned with fixed coords (set
     inline from the hovered height's bounding rect), so an ancestor's
     overflow:hidden can't clip it. translate(-50%, -100%) centers it
     horizontally over the height and lifts it just above. */
  position: fixed;
  transform: translate(-50%, -100%);
  z-index: 9999;
  white-space: nowrap;
  background: rgba(0, 0, 0, 0.92);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 6px;
  padding: 5px 9px;
  font-size: 11px;
  color: #ffffff;
  font-variant-numeric: tabular-nums;
  pointer-events: none;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.5);
`;

interface BlockHeightProps {
  height: number | null | undefined;
  /** Pre-known block timestamp (unix seconds) — skips the on-hover fetch. */
  ts?: number | null;
  /** Current chain tip; heights above it are "future" and show an ETA. */
  tip?: number | null;
  /** Build the explorer `/block` fetch URL (defaults to mainnet 0xmx). */
  resolveUrl?: BlockUrlResolver;
  /** Network for the in-app explorer link (default 'mainnet'). */
  network?: string;
  /** Show the hover timestamp tooltip (default true). */
  tooltip?: boolean;
  /** Override the displayed label (default: localized height). */
  children?: React.ReactNode;
  className?: string;
}

export const BlockHeight: React.FC<BlockHeightProps> = ({
  height,
  ts,
  tip,
  resolveUrl,
  network = 'mainnet',
  tooltip = true,
  children,
  className,
}) => {
  const wrapRef = useRef<HTMLSpanElement>(null);
  const [hovered, setHovered] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  const valid = typeof height === 'number' && Number.isFinite(height);
  const h = valid ? (height as number) : null;
  const isFuture = valid && tip !== null && tip !== undefined && (h as number) > tip;
  const hasKnownTs = typeof ts === 'number';
  const fetchEnabled = tooltip && hovered && valid && !hasKnownTs && !isFuture;
  const { ts: fetchedTs, loading } = useBlockTimestamp(h, { enabled: fetchEnabled, resolveUrl });

  if (!valid) return <span className={className}>—</span>;

  const label = children ?? (h as number).toLocaleString('en-US');

  let tipText: string;
  if (isFuture) tipText = fmtFutureEta((h as number) - (tip as number));
  else if (hasKnownTs) tipText = fmtTs(ts as number);
  else if (loading) tipText = 'Loading…';
  else if (typeof fetchedTs === 'number') tipText = fmtTs(fetchedTs);
  else tipText = 'timestamp unavailable';

  const search = `?network=${encodeURIComponent(network)}&type=block&height=${h}`;

  const onEnter = (): void => {
    const el = wrapRef.current;
    if (el) {
      const r = el.getBoundingClientRect();
      setPos({ x: r.left + r.width / 2, y: r.top });
    }
    setHovered(true);
  };

  return (
    <Wrap ref={wrapRef} className={className} onMouseEnter={onEnter} onMouseLeave={() => setHovered(false)}>
      <HeightLink
        to={{ pathname: ROUTES.NAV.EXPLORER_BEAM, search }}
        title="Open block in explorer"
        style={{ color: 'inherit' }}
      >
        {label}
      </HeightLink>
      {tooltip &&
        hovered &&
        pos &&
        createPortal(<Tip style={{ left: pos.x, top: pos.y - 8 }}>{tipText}</Tip>, document.body)}
    </Wrap>
  );
};

export default BlockHeight;
