const IMPOSTER_ASSET_ENTRIES: Array<[number, number]> = [
  // [fakeAssetId, realAssetId]

  // BEAM ASSETS
  [24, 0], // BEAM
  [26, 7], // BEAMX

  // BRIDGE ASSETS
  [40, 36], [17, 36], // bETH
  [41, 37], [18, 37], // bUSDT
  [42, 38], [19, 38], // bWBTC
  [43, 39], [35, 39], // bDAI

  // OTHER
  [25, 9], // TICO
];

const IMPOSTER_ASSET_MAP = new Map<number, number>(IMPOSTER_ASSET_ENTRIES);

const normalizeAssetId = (assetId: number | string | null | undefined): number | null => {
  if (assetId === null || assetId === undefined) return null;
  const parsed = Number(assetId);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
};

export const getRealAssetIdForFake = (assetId: number | string | null | undefined): number | null => {
  const normalized = normalizeAssetId(assetId);
  if (normalized === null) return null;
  return IMPOSTER_ASSET_MAP.get(normalized) ?? null;
};

export const isImposterAsset = (assetId: number | string | null | undefined): boolean => (
  getRealAssetIdForFake(assetId) !== null
);

export const poolHasImposterAsset = (
  aid1: number | string | null | undefined,
  aid2: number | string | null | undefined,
): boolean => isImposterAsset(aid1) || isImposterAsset(aid2);

export const getImposterAssetEntries = (): Array<[number, number]> => Array.from(IMPOSTER_ASSET_MAP.entries());
