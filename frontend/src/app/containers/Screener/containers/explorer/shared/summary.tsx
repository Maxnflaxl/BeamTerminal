import { styled } from '@linaria/react';
import { theme } from './theme';

// Shared chrome for the swap-listing pages (AtomicSwaps / AssetSwaps): the
// toolbar, the compact summary strip (one headline count + a wrapping chip row
// with non-zero entries highlighted), and the icon empty state. Kept in one
// place so the two pages stay visually in lockstep.

export const Toolbar = styled.div`
  display: flex;
  & > * + * {
    margin-left: 6px;
  }
  flex-wrap: wrap;
  margin: 8px 0 12px;
`;

export const SummaryStrip = styled.div`
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  background: ${theme.color.surface2};
  border: 1px solid ${theme.color.borderDim};
  border-radius: ${theme.radius.md};
  padding: 14px 18px;
  margin-bottom: 18px;
`;

export const Headline = styled.div`
  display: flex;
  flex-direction: column;
  margin-right: 22px;
`;

export const StatLabel = styled.div`
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: ${theme.color.muted};
`;

export const HeadNum = styled.div`
  font-family: var(--font-mono);
  font-size: 30px;
  font-weight: 700;
  line-height: 1;
  margin-top: 4px;
`;

// flex-wrap chip row spaced with the negative-outer-margin pattern — flex `gap`
// is unsupported on the wallet's QtWebEngine 5.15.2 (Chrome 83).
export const Chips = styled.div`
  display: flex;
  flex-wrap: wrap;
  margin: -4px;
  & > * {
    margin: 4px;
  }
`;

export const Chip = styled.div<{ hot?: boolean }>`
  display: flex;
  align-items: center;
  & > * + * {
    margin-left: 6px;
  }
  font-family: var(--font-mono);
  font-size: 12px;
  padding: 5px 10px;
  border-radius: 8px;
  background: ${(p) => (p.hot ? 'rgba(0, 246, 210, 0.08)' : 'rgba(255, 255, 255, 0.04)')};
  border: 1px solid ${(p) => (p.hot ? theme.color.accent : theme.color.borderDim)};
  color: ${(p) => (p.hot ? theme.color.text : theme.color.muted)};
  & .v {
    color: ${(p) => (p.hot ? theme.color.accent : theme.color.muted)};
  }
`;

export const EmptyState = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 46px 20px;
  color: ${theme.color.muted};
  & > * + * {
    margin-top: 6px;
  }
`;

export const EmptyIcon = styled.div`
  color: ${theme.color.accent};
  opacity: 0.85;
  margin-bottom: 6px;
  & svg {
    display: block;
    width: 40px;
    height: 40px;
  }
`;

export const EmptyTitle = styled.div`
  font-size: 15px;
  color: ${theme.color.text};
`;

export const EmptySub = styled.div`
  font-size: 12.5px;
  max-width: 440px;
`;

/** "Xs/m/h/d ago" from an ISO timestamp (wallet-gossip feeds report ISO). */
export function fmtRelative(iso: string): string {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return '—';
  const delta = Math.round((Date.now() - ts) / 1000);
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.round(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.round(delta / 3600)}h ago`;
  return `${Math.round(delta / 86400)}d ago`;
}
