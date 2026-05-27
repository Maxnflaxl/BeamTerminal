import React, {
  createContext, useContext, useMemo,
} from 'react';
import { normalizeOptColor } from '@app/shared/components/AssetsIcon';
import { useAssets } from './hooks';

// The screener is API-driven and runs headless on the public site, so the
// dex-app's on-chain `assetsList` (which carries OPT_COLOR) isn't loaded.
// This provider sources the colours from `/api/assets` once and exposes an
// aid → hex map so any AssetIcon can be tinted without per-row fetches.
const AssetColorsCtx = createContext<Map<number, string>>(new Map());

export const AssetColorsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { data } = useAssets();
  const map = useMemo(() => {
    const m = new Map<number, string>();
    for (const a of data?.assets ?? []) {
      const c = normalizeOptColor(a.color);
      if (c) m.set(a.aid, c);
    }
    return m;
  }, [data]);
  return <AssetColorsCtx.Provider value={map}>{children}</AssetColorsCtx.Provider>;
};

/** Brand colour (OPT_COLOR) for an asset, or undefined when none is defined. */
export function useAssetColor(aid: number | null | undefined): string | undefined {
  const map = useContext(AssetColorsCtx);
  return aid != null ? map.get(aid) : undefined;
}
