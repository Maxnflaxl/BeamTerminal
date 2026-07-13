import { useEffect, useState } from 'react';
import { styled } from '@linaria/react';

// Single source for the Screener's mobile breakpoint. Linaria resolves the
// interpolations at build time, so styled/css templates can write:
//   ${MOBILE_MEDIA} { ... }   →   @media (max-width: 640px) { ... }
export const MOBILE_BREAKPOINT = 640;
export const MOBILE_MEDIA = `@media (max-width: ${MOBILE_BREAKPOINT}px)`;
// matchMedia form (no "@media" prefix), for useMediaQuery.
export const MOBILE_QUERY = `(max-width: ${MOBILE_BREAKPOINT}px)`;

export const DesktopOnly = styled.div`
  ${MOBILE_MEDIA} {
    display: none;
  }
`;

export const MobileOnly = styled.div`
  display: none;
  ${MOBILE_MEDIA} {
    display: block;
  }
`;

// matchMedia is available in the wallet's QtWebEngine (Chrome 83), but keep the
// typeof guards for SSR-ish tooling contexts.
export function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState(
    () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false),
  );
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mql = window.matchMedia(query);
    const onChange = (): void => setMatch(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return match;
}

export const useIsMobile = (): boolean => useMediaQuery(MOBILE_QUERY);
