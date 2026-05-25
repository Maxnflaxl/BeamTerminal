import React, {
  useEffect, useMemo, useRef, useState,
} from 'react';
import { styled } from '@linaria/react';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import { IAsset, IOptions } from '@core/types';
import { assetShortLabel } from '@core/appUtils';
import { selectAssetsList, selectFavoriteAssets, selectPoolsList } from '@app/containers/Pools/store/selectors';
import * as mainActions from '@app/containers/Pools/store/actions';
import {
  ASSET_BEAM,
  isImposterAsset,
  poolHasImposterAsset,
} from '@app/shared/constants';
import AssetIcon from '@app/shared/components/AssetsIcon';
import { CancelIcon, IconFavorite, IconFavoriteFilled } from '@app/shared/icons';
import { iconButtonReset, rowCenter, warningBadgeBase } from '../../../styles/linariaShared';
import { AssetSearchModalProps } from './AssetSearchModal.types';

const BEAM_ASSET: IAsset = {
  asset_id: 0,
  metadata: '',
  parsedMetadata: ASSET_BEAM as any,
  owner_pk: '',
};

type SearchTab = 'ALL' | 'ASSET' | 'POOL';
type AssetFavTab = 'ALL' | 'FAV' | 'EXCL_AMML';
const KIND_PCT: Record<number, string> = { 0: '0.05%', 1: '0.3%', 2: '1%' };
const AMM_META_REGEX = /Amm Liquidity Token (\d+)-(\d+)-(\d+)/;

const ModalBackdrop = styled.div`
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 10100;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
`;

const ModalPanel = styled.div`
  width: 420px;
  max-width: 92vw;
  max-height: 70vh;
  background: var(--color-dark-blue);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 18px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
`;

const ModalHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 16px 12px;
  flex-shrink: 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
`;

const ModalTitle = styled.span`
  font-size: 14px;
  font-weight: 700;
  color: white;
  text-transform: uppercase;
  letter-spacing: 2px;
`;

const CloseButton = styled('button')`
  ${iconButtonReset}
  padding: 4px;
  opacity: 0.5;
  &:hover { opacity: 1; }
`;

const SearchInput = styled.input`
  margin: 12px 16px 0;
  width: calc(100% - 32px);
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  color: white;
  font-size: 14px;
  font-family: 'ProximaNova', 'SFProDisplay', sans-serif;
  padding: 10px 14px;
  outline: none;
  flex-shrink: 0;
  box-sizing: border-box;
  &::placeholder { color: rgba(255, 255, 255, 0.4); }
  &:focus { border-color: var(--color-green); }
`;

const TabBar = styled.div`
  display: flex;
  align-items: center;
  gap: 0;
  padding: 10px 16px 0;
  flex-shrink: 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
`;

const TabButton = styled.button<{ active: boolean }>`
  background: transparent;
  border: none;
  color: ${({ active }) => (active ? 'white' : 'rgba(255, 255, 255, 0.5)')};
  border-bottom: ${({ active }) => (active ? '2px solid var(--color-green)' : '2px solid transparent')};
  text-transform: uppercase;
  font-size: 12px;
  font-weight: 700;
  padding: 4px 12px 8px;
  cursor: pointer;
`;

const ResultList = styled.div`
  overflow-y: auto;
  flex: 1;
  padding: 6px 0 8px;

  &::-webkit-scrollbar { width: 4px; }
  &::-webkit-scrollbar-thumb {
    background-color: rgba(255, 255, 255, 0.2);
    border-radius: 3px;
  }
  &::-webkit-scrollbar-thumb:hover { background: var(--color-green); }
`;

const SectionLabel = styled.div`
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: rgba(255, 255, 255, 0.35);
  padding: 10px 16px 4px;
`;

const AssetRow = styled.button<{ excluded?: boolean }>`
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 16px;
  background: transparent;
  border: none;
  cursor: ${({ excluded }) => (excluded ? 'not-allowed' : 'pointer')};
  color: white;
  text-align: left;
  opacity: ${({ excluded }) => (excluded ? 0.3 : 1)};
  &:hover { background: ${({ excluded }) => (excluded ? 'transparent' : 'rgba(255, 255, 255, 0.05)')}; }
`;

const AssetRowText = styled.div`
  flex: 1;
  min-width: 0;
`;

const AssetName = styled.div`
  font-size: 14px;
  font-weight: 600;
  color: white;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;

const AssetSub = styled.div`
  font-size: 11px;
  color: rgba(255, 255, 255, 0.45);
  text-transform: uppercase;
  margin-top: 1px;
`;

const AssetIdBadge = styled.span`
  font-size: 11px;
  color: rgba(255, 255, 255, 0.3);
  white-space: nowrap;
  flex-shrink: 0;
`;

const WarningBadge = styled('span')`
  ${warningBadgeBase}
  padding: 1px 7px;
`;

const RowAction = styled.span`
  font-size: 10px;
  color: var(--color-green);
  opacity: 0.6;
  white-space: nowrap;
  flex-shrink: 0;
  margin-left: 4px;
`;

const StarButton = styled('button')`
  ${iconButtonReset}
  padding: 4px;
  flex-shrink: 0;
  opacity: 0.6;
  &:hover { opacity: 1; }
`;

const FilterWrap = styled.div`
  position: relative;
  flex-shrink: 0;
  margin-left: auto;
  padding-bottom: 8px;
`;

const FilterBtn = styled('button')<{ active: boolean }>`
  background: ${({ active }) => (active ? 'rgba(0, 246, 170, 0.12)' : 'rgba(255, 255, 255, 0.06)')};
  border: 1px solid ${({ active }) => (active ? 'var(--color-green)' : 'rgba(255, 255, 255, 0.1)')};
  border-radius: 8px;
  color: ${({ active }) => (active ? 'var(--color-green)' : 'rgba(255, 255, 255, 0.6)')};
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  padding: 4px 10px;
  cursor: pointer;
  ${rowCenter}
  gap: 4px;
  white-space: nowrap;
`;

const FilterDropdown = styled.div`
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  background: var(--color-dark-blue);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 10px;
  overflow: hidden;
  z-index: 10;
  min-width: 130px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
`;

const FilterOption = styled.button<{ selected: boolean }>`
  display: block;
  width: 100%;
  padding: 9px 14px;
  background: transparent;
  border: none;
  text-align: left;
  color: ${({ selected }) => (selected ? 'var(--color-green)' : 'rgba(255, 255, 255, 0.7)')};
  font-size: 12px;
  font-weight: ${({ selected }) => (selected ? 700 : 400)};
  cursor: pointer;
  &:hover { background: rgba(255, 255, 255, 0.06); }
`;

const NoResults = styled.div`
  padding: 24px 16px;
  color: rgba(255, 255, 255, 0.35);
  font-size: 13px;
  text-align: center;
`;

const AssetSearchModal: React.FC<AssetSearchModalProps> = ({
  isOpen,
  onClose,
  onSelect,
  excludeAssetId = null,
  allowedAssetIds = null,
  mode = 'asset-only',
  title,
  onPairSelect,
}) => {
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<SearchTab>('ALL');
  const [favTab, setFavTab] = useState<AssetFavTab>('ALL');
  const [filterOpen, setFilterOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement>(null);
  const assetsList = useSelector(selectAssetsList());
  const poolsList = useSelector(selectPoolsList());
  const favoriteAssets = useSelector(selectFavoriteAssets());
  const dispatch = useDispatch();
  const navigate = useNavigate();

  const favoriteSet = useMemo(() => new Set(favoriteAssets || []), [favoriteAssets]);

  const getAssetId = (asset: IAsset) => asset.asset_id ?? (asset as any).aid ?? 0;

  const allAssets = useMemo<IAsset[]>(() => [BEAM_ASSET, ...(assetsList || [])], [assetsList]);
  const assetsById = useMemo<Map<number, IAsset>>(
    () => new Map(allAssets.map((asset) => [getAssetId(asset), asset])),
    [allAssets],
  );

  const getAmmMeta = (asset: IAsset) => {
    const metadata = asset.parsedMetadata as any;
    if (metadata?.SN !== 'AmmL') return null;
    const match = (metadata?.N || '').match(AMM_META_REGEX);
    if (!match) return null;
    return {
      aid1: parseInt(match[1], 10),
      aid2: parseInt(match[2], 10),
      kind: parseInt(match[3], 10),
    };
  };

  const getAmmTokenLabel = (assetId: number) => {
    const token = assetsById.get(assetId);
    return token ? assetShortLabel(token.parsedMetadata) : String(assetId);
  };

  const normalizeToken = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  const isAmmSearchQuery = (value: string) => value.trim().toLowerCase().startsWith('amml');

  const getAmmLabel = (asset: IAsset): string | null => {
    const ammMeta = getAmmMeta(asset);
    if (!ammMeta) return null;
    const t1 = getAmmTokenLabel(ammMeta.aid1);
    const t2 = getAmmTokenLabel(ammMeta.aid2);
    return `AMML (${t1}(${ammMeta.aid1})/${t2}(${ammMeta.aid2}) - ${KIND_PCT[ammMeta.kind] ?? `${ammMeta.kind}`})`;
  };

  const getAmmSearchTokens = (asset: IAsset): string[] => {
    const ammMeta = getAmmMeta(asset);
    if (!ammMeta) return [];

    const t1 = getAmmTokenLabel(ammMeta.aid1);
    const t2 = getAmmTokenLabel(ammMeta.aid2);
    const fee = KIND_PCT[ammMeta.kind] ?? `${ammMeta.kind}`;
    const pairWithIds = `${t1}(${ammMeta.aid1})/${t2}(${ammMeta.aid2})`;
    const pairNoIds = `${t1}/${t2}`;
    const pairIdsOnly = `${ammMeta.aid1}/${ammMeta.aid2}`;
    const pairIdsWithKind = `${ammMeta.aid1}/${ammMeta.aid2}/${ammMeta.kind}`;
    const fullLabel = `AMML (${pairWithIds} - ${fee})`;
    const noFeeLabel = `AMML (${pairWithIds})`;
    const compactLabel = `AMML ${pairWithIds}`;

    return [
      fullLabel.toLowerCase(),
      noFeeLabel.toLowerCase(),
      compactLabel.toLowerCase(),
      pairWithIds.toLowerCase(),
      pairNoIds.toLowerCase(),
      pairIdsOnly.toLowerCase(),
      pairIdsWithKind.toLowerCase(),
      `amml ${pairNoIds}`.toLowerCase(),
      `amml ${pairIdsOnly}`.toLowerCase(),
      `amml ${pairIdsWithKind}`.toLowerCase(),
      `amml ${fee}`.toLowerCase(),
      `amml ${pairNoIds} ${fee}`.toLowerCase(),
      normalizeToken(fullLabel),
      normalizeToken(noFeeLabel),
      normalizeToken(pairWithIds),
      normalizeToken(pairNoIds),
      normalizeToken(pairIdsOnly),
      normalizeToken(pairIdsWithKind),
      normalizeToken(`amml ${pairNoIds} ${fee}`),
    ];
  };

  const filteredAssets = useMemo(() => {
    const q = query.trim().toLowerCase();
    const normalizedQ = normalizeToken(q);
    if (!q) return allAssets;
    return allAssets.filter((asset) => {
      const id = String(asset.asset_id ?? (asset as any).aid ?? '');
      const m = asset.parsedMetadata;
      const ammTokens = getAmmSearchTokens(asset);
      return (
        id === q
        || (m?.SN || '').toLowerCase().includes(q)
        || (m?.UN || '').toLowerCase().includes(q)
        || (m?.N || '').toLowerCase().includes(q)
        || ammTokens.some((token) => token.includes(q))
        || (normalizedQ.length > 0 && ammTokens.some((token) => normalizeToken(token).includes(normalizedQ)))
      );
    });
  }, [allAssets, query, assetsById]);

  const displayedAssets = useMemo(() => {
    let list = filteredAssets;
    if (allowedAssetIds != null) {
      list = list.filter((a) => allowedAssetIds.has(getAssetId(a)));
    }
    if (favTab === 'EXCL_AMML') return list.filter((a) => getAmmMeta(a) === null);
    if (favTab === 'FAV') return list.filter((a) => favoriteSet.has(getAssetId(a)));
    return list;
  }, [filteredAssets, favTab, favoriteSet, allowedAssetIds]);

  const poolPairResults = useMemo(() => {
    if (mode !== 'explore' || !query.includes('/')) return [];
    const [leftQ, rightQ] = query.split('/').map((s) => s.trim().toLowerCase());
    if (!leftQ) return [];

    const matchAssets = (q: string, exact = false) => allAssets.filter((a) => {
      const m = a.parsedMetadata;
      const idStr = String(a.asset_id ?? (a as any).aid ?? '');
      if (exact) {
        return (m?.SN || '').toLowerCase() === q
          || (m?.UN || '').toLowerCase() === q
          || (m?.N || '').toLowerCase() === q
          || idStr === q;
      }
      return (m?.SN || '').toLowerCase().includes(q)
        || (m?.UN || '').toLowerCase().includes(q)
        || (m?.N || '').toLowerCase().includes(q)
        || idStr.includes(q);
    });

    const lefts = matchAssets(leftQ, true); // exact: "BEAM" must not match "BEAMX"
    const results: Array<{ aid1: number; aid2: number; label: string }> = [];
    const seen = new Set<string>();

    for (const l of lefts) {
      const lid = getAssetId(l);
      const matchingPools = (poolsList || []).filter((p) => p.aid1 === lid || p.aid2 === lid);

      for (const pool of matchingPools) {
        const otherId = pool.aid1 === lid ? pool.aid2 : pool.aid1;

        // If right side is being typed, filter the other asset by it
        if (rightQ) {
          const otherAsset = allAssets.find((a) => getAssetId(a) === otherId);
          if (!otherAsset) continue;
          const om = otherAsset.parsedMetadata;
          const matches = (om?.SN || '').toLowerCase().includes(rightQ)
            || (om?.UN || '').toLowerCase().includes(rightQ)
            || (om?.N || '').toLowerCase().includes(rightQ)
            || String(otherId).includes(rightQ);
          if (!matches) continue;
        }

        const key = `${pool.aid1}-${pool.aid2}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const otherAsset = allAssets.find((a) => getAssetId(a) === otherId);
        const otherLabel = otherAsset ? assetShortLabel(otherAsset.parsedMetadata) : String(otherId);
        const leftFirst = pool.aid1 === lid;
        results.push({
          aid1: leftFirst ? lid : otherId,
          aid2: leftFirst ? otherId : lid,
          label: `${assetShortLabel(l.parsedMetadata)}/${otherLabel}`,
        });
      }
    }
    return results;
  }, [mode, query, allAssets, poolsList]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!filterOpen) return undefined;
    const handler = (e: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) {
        setFilterOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [filterOpen]);

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setTab('ALL');
      setFavTab('ALL');
      setFilterOpen(false);
    }
  }, [isOpen]);

  useEffect(() => {
    if (mode === 'explore' && query.includes('/') && !isAmmSearchQuery(query)) setTab('POOL');
  }, [mode, query]);

  if (!isOpen) return null;

  const buildOption = (asset: IAsset): IOptions => ({
    value: getAssetId(asset),
    label: assetShortLabel(asset.parsedMetadata),
  });

  const handleAssetOnlySelect = (asset: IAsset) => {
    const id = getAssetId(asset);
    if (id === excludeAssetId) return;
    const shouldClose = onSelect(buildOption(asset));
    if (shouldClose !== false) {
      onClose();
    }
  };

  const handleNavigateToAsset = (asset: IAsset) => {
    navigate(`/asset/${getAssetId(asset)}`);
    onClose();
  };

  const handleFilterSelect = (asset: IAsset) => {
    onSelect(buildOption(asset));
    onClose();
  };

  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  };

  const defaultTitle = mode === 'explore' ? 'Search' : 'Select a token';

  const renderAssetRow = (
    asset: IAsset,
    onClick: (a: IAsset) => void,
    actionLabel?: string,
    keyPrefix = '',
  ) => {
    const id = getAssetId(asset);
    const m = asset.parsedMetadata;
    const ammLabel = getAmmLabel(asset);
    const name = ammLabel || m?.UN || m?.N || 'Unknown';
    const ticker = ammLabel ? null : assetShortLabel(m);
    const isExcluded = mode === 'asset-only' && id === excludeAssetId;
    const hasImposterWarning = isImposterAsset(id);

    return (
      <AssetRow
        key={`${keyPrefix}${id}`}
        type="button"
        excluded={isExcluded}
        onClick={() => !isExcluded && onClick(asset)}
        disabled={isExcluded}
      >
        <AssetIcon asset_id={id} />
        <AssetRowText>
          <AssetName>{name}</AssetName>
          {ticker && ticker !== name && <AssetSub>{ticker}</AssetSub>}
        </AssetRowText>
        {hasImposterWarning && <WarningBadge>fake</WarningBadge>}
        <AssetIdBadge style={hasImposterWarning ? { marginLeft: 6 } : undefined}>{`id:${id}`}</AssetIdBadge>
        {actionLabel && <RowAction>{actionLabel}</RowAction>}
        <StarButton
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            dispatch(mainActions.onToggleFavoriteAsset.request(id));
          }}
        >
          {favoriteSet.has(id) ? <IconFavoriteFilled /> : <IconFavorite />}
        </StarButton>
      </AssetRow>
    );
  };

  const noResults = displayedAssets.length === 0;

  const renderAssetList = (onClick: (a: IAsset) => void, action?: string, prefix = '', emptyMsg = 'No assets found') => (
    noResults
      ? <NoResults>{favTab === 'FAV' ? 'No favorite assets yet. Click ★ to add.' : favTab === 'EXCL_AMML' ? 'No non-AMML assets found.' : emptyMsg}</NoResults>
      : displayedAssets.map((a) => renderAssetRow(a, onClick, action, prefix))
  );

  const renderContent = () => {
    if (mode === 'asset-only') {
      return renderAssetList(handleAssetOnlySelect);
    }

    if (tab === 'ASSET') {
      return renderAssetList(handleNavigateToAsset, '→ info', 'nav-');
    }

    if (tab === 'POOL') {
      return renderAssetList(handleFilterSelect, '→ filter', 'flt-', 'No pools found');
    }

    // ALL tab
    return (
      <>
        <SectionLabel>Assets</SectionLabel>
        {renderAssetList(handleNavigateToAsset, '→ info', 'all-nav-')}
        <SectionLabel>Filter pools by asset</SectionLabel>
        {renderAssetList(handleFilterSelect, '→ filter', 'all-flt-', 'No pools found')}
      </>
    );
  };

  const modal = (
    <ModalBackdrop onClick={handleBackdropClick}>
      <ModalPanel onClick={(e) => e.stopPropagation()}>
        <ModalHeader>
          <ModalTitle>{title || defaultTitle}</ModalTitle>
          <CloseButton onClick={onClose} aria-label="Close">
            <CancelIcon />
          </CloseButton>
        </ModalHeader>

        <SearchInput
          autoFocus
          placeholder="Search for a name or ID"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        <TabBar>
          {mode === 'explore' ? (
            <>
              {(['ALL', 'ASSET', 'POOL'] as SearchTab[]).map((t) => (
                <TabButton key={t} active={tab === t} onClick={() => setTab(t)}>
                  {t}
                </TabButton>
              ))}
              <FilterWrap ref={filterRef}>
                <FilterBtn
                  type="button"
                  active={favTab !== 'ALL'}
                  onClick={() => setFilterOpen((o) => !o)}
                >
                  {favTab === 'FAV' ? '★ Favorite' : favTab === 'EXCL_AMML' ? 'Excl. AMML' : 'All'}
                  {' ▾'}
                </FilterBtn>
                {filterOpen && (
                  <FilterDropdown>
                    {(['ALL', 'FAV', 'EXCL_AMML'] as AssetFavTab[]).map((t) => (
                      <FilterOption
                        key={t}
                        type="button"
                        selected={favTab === t}
                        onClick={() => { setFavTab(t); setFilterOpen(false); }}
                      >
                        {t === 'FAV' ? '★ Favorite' : t === 'EXCL_AMML' ? 'Excl. AMML' : 'All'}
                      </FilterOption>
                    ))}
                  </FilterDropdown>
                )}
              </FilterWrap>
            </>
          ) : (
            <>
              {(['ALL', 'FAV', 'EXCL_AMML'] as AssetFavTab[]).map((t) => (
                <TabButton key={t} active={favTab === t} onClick={() => setFavTab(t)}>
                  {t === 'FAV' ? 'Favorite' : t === 'EXCL_AMML' ? 'Excl. AMML' : 'All'}
                </TabButton>
              ))}
            </>
          )}
        </TabBar>

        <ResultList>
          {query.includes('/') && tab !== 'ASSET' && !isAmmSearchQuery(query) ? (() => {
            const displayedPairs = favTab === 'FAV'
              ? poolPairResults.filter((p) => favoriteSet.has(p.aid1) && favoriteSet.has(p.aid2))
              : poolPairResults;
            if (displayedPairs.length === 0) {
              return (
                <NoResults>
                  {favTab === 'FAV' ? 'No pool matches your favorite assets.' : 'No pools found'}
                </NoResults>
              );
            }
            return (
              <>
                <SectionLabel>Pools</SectionLabel>
                {displayedPairs.map((pair) => {
                  const hasImposterWarning = poolHasImposterAsset(pair.aid1, pair.aid2);
                  return (
                    <AssetRow
                      key={`pair-${pair.aid1}-${pair.aid2}`}
                      type="button"
                      onClick={() => {
                        onPairSelect?.(pair.aid1, pair.aid2, pair.label);
                        onClose();
                      }}
                    >
                      <AssetIcon asset_id={pair.aid1} />
                      <AssetIcon asset_id={pair.aid2} />
                      <AssetRowText>
                        <AssetName>{pair.label}</AssetName>
                      </AssetRowText>
                      {hasImposterWarning && <WarningBadge>fake asset</WarningBadge>}
                      <RowAction>→ filter</RowAction>
                    </AssetRow>
                  );
                })}
              </>
            );
          })() : renderContent()}
        </ResultList>
      </ModalPanel>
    </ModalBackdrop>
  );

  return modal;
};

export default AssetSearchModal;
