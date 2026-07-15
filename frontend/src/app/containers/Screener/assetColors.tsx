import React, { createContext, useContext, useMemo, useRef } from 'react';
import { normalizeOptColor } from '@app/shared/components/AssetsIcon';
import { useAssets } from './hooks';

// The screener is API-driven and runs headless on the public site, so the
// dex-app's on-chain `assetsList` (which carries OPT_COLOR) isn't loaded.
// This provider sources the colours from `/api/assets` once and exposes an
// aid → hex map so any AssetIcon can be tinted without per-row fetches.
const AssetColorsCtx = createContext<Map<number, string>>(new Map());

export const AssetColorsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { data } = useAssets();
  const prevRef = useRef<Map<number, string>>(new Map());
  const map = useMemo(() => {
    const m = new Map<number, string>();
    for (const a of data?.assets ?? []) {
      const c = normalizeOptColor(a.color);
      if (c) m.set(a.aid, c);
    }
    // Reuse the previous Map identity when the colours are unchanged — a new
    // context value would re-render every icon consumer app-wide even though
    // the asset list rarely changes between polls.
    const prev = prevRef.current;
    if (prev.size === m.size) {
      let same = true;
      m.forEach((v, k) => {
        if (prev.get(k) !== v) same = false;
      });
      if (same) return prev;
    }
    prevRef.current = m;
    return m;
  }, [data]);
  return <AssetColorsCtx.Provider value={map}>{children}</AssetColorsCtx.Provider>;
};

/** Brand colour (OPT_COLOR) for an asset, or undefined when none is defined. */
export function useAssetColor(aid: number | null | undefined): string | undefined {
  const map = useContext(AssetColorsCtx);
  return aid != null ? map.get(aid) : undefined;
}
