import React, { useMemo, useState } from 'react';
import { styled } from '@linaria/react';
import { useNavigate } from 'react-router-dom';
import { useDispatch, useSelector } from 'react-redux';
import { IOptions, IPoolCard, KindProcent } from '@core/types';
import {
  Button, Container, Window,
} from '@app/shared/components';
import { AssetSelectorButton } from '@app/shared/components/AssetSearchModal';
import { getFilterPools, onFilter, onFeeFilter } from '@core/appUtils';
import { CancelIcon, IconPlus } from '@app/shared/icons';
import {
  ROUTES, SORT, kindSelect, getRealAssetIdForFake, poolHasImposterAsset,
} from '@app/shared/constants';
import {
  selectFavorites, selectFeeFilter, selectFilter, selectPoolsList,
} from '@app/containers/Pools/store/selectors';
import * as mainActions from '@app/containers/Pools/store/actions';
import { PoolTable } from '@app/containers/Pools/containers/shared/PoolTable';

const Header = styled.div`
  width: 100%;
  max-width: 1100px;
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
  @media (max-width: 913px) {
    flex-direction: column;
  }
`;

const Left = styled.div`
  flex: 0 0 260px;
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  margin-right: 12px;

  @media (max-width: 480px) {
    flex: 1 1 auto;
    width: 100%;
    max-width: 100%;
    margin-right: 0;
  }
`;

const SelectorWrap = styled.div`
  flex: 1;
  min-width: 0;
`;

const Center = styled.div`
  flex: 1;
  display: flex;
  justify-content: center;

  @media (max-width: 480px) {
    width: 100%;
    flex: 1 1 100%;
  }
`;

const Right = styled.div`
  width: 180px;
  display: flex;
  justify-content: flex-end;

  @media (max-width: 480px) {
    width: 100%;
    justify-content: center;
  }
`;

const Sort = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
`;

const FilterButton = styled.button<{ active: boolean }>`
  background: transparent;
  border: none;
  color: ${({ active }) => (active ? 'white' : 'rgba(255, 255, 255, 0.5)')};
  border-bottom: ${({ active }) => (active ? '2px solid var(--color-green)' : '2px solid transparent')};
  text-transform: uppercase;
  font-size: 12px;
  font-weight: 700;
  padding: 4px 8px;
  cursor: pointer;
  margin-right: 4px;

  &:last-child {
    margin-right: 0;
  }
`;

const FeeSort = styled.div`
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  margin-left: 16px;
  padding-left: 16px;
  border-left: 1px solid rgba(255, 255, 255, 0.15);
`;

const ClearBtn = styled.button`
  background: transparent;
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  color: rgba(255, 255, 255, 0.4);
  padding: 4px;
  flex-shrink: 0;

  &:hover { color: white; }
`;

export const ExplorePools = () => {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const data = useSelector(selectPoolsList());
  const favorites = useSelector(selectFavorites());
  const currentFilter = useSelector(selectFilter());
  const currentFeeFilter = useSelector(selectFeeFilter());
  const [assetFilter, setAssetFilter] = useState<IOptions | null>(null);
  const [pairFilter, setPairFilter] = useState<{ aid1: number; aid2: number; label: string } | null>(null);

  const rows = useMemo(() => {
    const filteredByTab = onFilter(data, currentFilter, favorites);
    let filtered: IPoolCard[];
    if (pairFilter) {
      filtered = filteredByTab.filter((p) => (p.aid1 === pairFilter.aid1 && p.aid2 === pairFilter.aid2)
        || (p.aid1 === pairFilter.aid2 && p.aid2 === pairFilter.aid1));
    } else {
      filtered = getFilterPools(assetFilter, filteredByTab) || [];
    }
    return onFeeFilter(filtered, currentFeeFilter);
  }, [data, currentFilter, favorites, assetFilter, pairFilter, currentFeeFilter]);

  const tableEmptyMessage = useMemo(() => {
    if (currentFilter === 'fav') return 'No favorite pools';
    if (currentFilter === 'created') return 'No created pools';
    return 'No pools found';
  }, [currentFilter]);

  const handleFavorite = (pool: IPoolCard) => {
    dispatch(mainActions.onFavorites.request(pool));
  };

  const onOpenTrade = (pool: IPoolCard) => {
    if (poolHasImposterAsset(pool.aid1, pool.aid2)) {
      const poolWarnings = [pool.aid1, pool.aid2]
        .map((assetId) => {
          const realId = getRealAssetIdForFake(assetId);
          return realId === null ? null : `fake id ${assetId}; real id ${realId}`;
        })
        .filter(Boolean)
        .join('\n');
      const continueTrade = window.confirm(
        `Selected pool contains imposter assets:\n${poolWarnings}\n\nPress OK to continue anyways.\nPress Cancel to stop.`,
      );
      if (!continueTrade) return;
    }
    dispatch(mainActions.setCurrentPool(pool));
    dispatch(mainActions.setPredict(null));
    navigate(ROUTES.NAV.TRADE);
  };

  return (
    <Window hideHeader>
      <Container>
        <Header>
          <Left>
            <SelectorWrap>
              <AssetSelectorButton
                value={pairFilter ? { value: -1, label: pairFilter.label } : assetFilter}
                onSelect={(opt) => { setAssetFilter(opt); setPairFilter(null); }}
                placeholder="Search..."
                mode="explore"
                onPairSelect={(aid1, aid2, label) => { setPairFilter({ aid1, aid2, label }); setAssetFilter(null); }}
              />
            </SelectorWrap>
            {(assetFilter || pairFilter) && (
              <ClearBtn
                onClick={() => { setAssetFilter(null); setPairFilter(null); }}
                type="button"
                aria-label="Clear filter"
              >
                <CancelIcon />
              </ClearBtn>
            )}
          </Left>
          <Center>
            <Sort>
              {SORT.map((item) => (
                <FilterButton
                  key={item.value}
                  active={currentFilter === item.value}
                  onClick={() => dispatch(mainActions.setFilter(item.value))}
                >
                  {item.name}
                </FilterButton>
              ))}
              <FeeSort>
                <FilterButton
                  active={currentFeeFilter === null}
                  onClick={() => dispatch(mainActions.setFeeFilter(null))}
                >
                  All
                </FilterButton>
                {kindSelect.map((item) => (
                  <FilterButton
                    key={item.label}
                    active={currentFeeFilter === (item.label as KindProcent)}
                    onClick={() => dispatch(mainActions.setFeeFilter(item.label as KindProcent))}
                  >
                    {item.label}
                  </FilterButton>
                ))}
              </FeeSort>
            </Sort>
          </Center>
          <Right>
            <Button icon={IconPlus} variant="ghost" onClick={() => navigate(ROUTES.POOLS.CREATE_POOL)}>
              Create Pool
            </Button>
          </Right>
        </Header>
        <PoolTable
          rows={rows}
          favorites={favorites || []}
          onFavorite={handleFavorite}
          onOpenTrade={onOpenTrade}
          emptyMessage={tableEmptyMessage}
        />
      </Container>
    </Window>
  );
};

export default ExplorePools;
