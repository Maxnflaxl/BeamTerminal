import React, { createContext, useContext, useMemo, useRef } from 'react';
import { normalizeOptColor } from '@app/shared/components/AssetsIcon';
import { useAssets, usePolled } from './hooks';
import { api } from './api/client';
import type { ApiAssetsList } from './api/types';

type AssetsState = ReturnType<typeof useAssets>;
type AssetEntry = ApiAssetsList['assets'][number];

// The screener is API-driven and runs headless on the public site, so the
// dex-app's on-chain `assetsList` (which carries OPT_COLOR) isn't loaded.
// This provider is the single owner of the `/api/assets` poll: it exposes the
// raw catalogue state (so pages don't each poll the same endpoint) and an
// aid → hex map so any AssetIcon can be tinted without per-row fetches.
const AssetColorsCtx = createContext<Map<number, string>>(new Map());
// `null` means no provider is mounted — consumers then poll on their own.
const AssetsCtx = createContext<AssetsState | null>(null);

export const AssetColorsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const assets = useAssets();
  const { data } = assets;
  // The hook spreads a fresh object per render; memo on its fields so the
  // context value (and every consumer) only changes when the poll does.
  const assetsValue = useMemo(() => assets, [assets.data, assets.loading, assets.error, assets.refetch]); // eslint-disable-line react-hooks/exhaustive-deps
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
  return (
    <AssetsCtx.Provider value={assetsValue}>
      <AssetColorsCtx.Provider value={map}>{children}</AssetColorsCtx.Provider>
    </AssetsCtx.Provider>
  );
};

/** Brand colour (OPT_COLOR) for an asset, or undefined when none is defined. */
export function useAssetColor(aid: number | null | undefined): string | undefined {
  const map = useContext(AssetColorsCtx);
  return aid != null ? map.get(aid) : undefined;
}

/** The `/api/assets` catalogue from the provider's single poll; falls back to
 *  an own poll only when no AssetColorsProvider is mounted above. */
export function useSharedAssets(): AssetsState {
  const shared = useContext(AssetsCtx);
  const own = usePolled(() => api.assets(), [], 60_000, shared === null);
  return shared ?? own;
}

/** aid → catalogue entry over `useSharedAssets`, rebuilt only when the
 *  payload changes. */
export function useSharedAssetIndex(): Map<number, AssetEntry> {
  const { data } = useSharedAssets();
  return useMemo(() => {
    const m = new Map<number, AssetEntry>();
    for (const a of data?.assets ?? []) m.set(a.aid, a);
    return m;
  }, [data]);
}
