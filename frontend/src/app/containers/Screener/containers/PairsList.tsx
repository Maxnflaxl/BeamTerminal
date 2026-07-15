import React, { useState, useMemo, useCallback } from 'react';
import { styled } from '@linaria/react';
import { useNavigate, Link } from 'react-router-dom';
import { ROUTES } from '@app/shared/constants';
import IconFavorite from '@app/shared/icons/icon-favorite.svg';
import IconFavoriteFilled from '@app/shared/icons/icon-favorite-filled.svg';
import { MOBILE_MEDIA, DesktopOnly, MobileOnly, useIsMobile } from '../components/responsive';
import { usePairs, useStats } from '../hooks';
import type { ApiPair, SortKey, SortOrder } from '../api/types';
import { StatsBar } from '../components/StatsBar';
import { ScreenerTable } from '../components/ScreenerTable';
import { IconsPair } from '../components/IconsPair';
import { TiersBadge } from '../components/KindBadge';
import { Sparkline } from '../components/Sparkline';
import { fmt$, fmtPct, fmtPrice, pairKey } from '../components/format';
import {
  ListPage as Page,
  SearchInput as Search,
  TableWrap,
  MobileCard as Card,
  MobileCardMain as CardMain,
  MobileCardTopRow as CardTopRow,
  MobileCardTitle as CardTitle,
  MobileCardSub as CardSub,
  MobileCardStats as CardStats,
  MobileCardStat as CardStat,
} from '../components/listPage';
import { useFavorites } from '../favorites';
import { CenteredNote } from '../components/CenteredNote';
import { useMyCreatedPairs, useWallet } from '../wallet';
import { CreatePoolModal } from '../components/CreatePoolModal';

// DEX-page row filters. `mine` (pairs the connected wallet created) is sourced
// from the AMM shader and only offered when a wallet is connected; the rest are
// derived from the public pairs feed + localStorage favorites.
type DexFilter = 'all' | 'mine' | 'liquid' | 'empty' | 'fav';

const Header = styled.div`
  max-width: 1400px;
  margin: 16px auto 0;
  padding: 0 20px;
  display: flex;
  align-items: center;
  & > * + * {
    margin-left: 16px;
  }

  ${MOBILE_MEDIA} {
    padding: 0 12px;
    & > * + * {
      margin-left: 10px;
    }
  }
`;

const LpButton = styled(Link)`
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  & > * + * {
    margin-left: 6px;
  }
  padding: 8px 14px;
  background: rgba(0, 246, 210, 0.12);
  border: 1px solid rgba(0, 246, 210, 0.45);
  border-radius: 8px;
  color: #00f6d2;
  font-size: 13px;
  text-decoration: none;
  white-space: nowrap;
  transition: background 120ms, border-color 120ms;
  &:hover {
    background: rgba(0, 246, 210, 0.22);
  }

  ${MOBILE_MEDIA} {
    font-size: 12px;
    padding: 8px 10px;
  }
`;

const CreatePoolBtn = styled.button`
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  padding: 8px 14px;
  background: var(--color-green);
  border: 1px solid var(--color-green);
  border-radius: 8px;
  color: var(--color-dark-blue);
  font-size: 13px;
  font-weight: 600;
  font-family: inherit;
  white-space: nowrap;
  cursor: pointer;
  transition: filter 120ms;
  &:hover {
    filter: brightness(1.08);
  }

  ${MOBILE_MEDIA} {
    font-size: 12px;
    padding: 8px 10px;
  }
`;

const SortBar = styled.div`
  display: flex;
  & > * + * {
    margin-left: 6px;
  }
  align-items: center;
  flex-wrap: wrap;
  margin: 0 0 12px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.5);
`;

const SortPill = styled.button<{ active?: boolean }>`
  background: ${(p) => (p.active ? 'rgba(0, 246, 210, 0.18)' : 'transparent')};
  color: ${(p) => (p.active ? '#00f6d2' : 'rgba(255, 255, 255, 0.7)')};
  border: 1px solid ${(p) => (p.active ? 'rgba(0, 246, 210, 0.5)' : 'rgba(255, 255, 255, 0.12)')};
  border-radius: 14px;
  padding: 4px 10px;
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
`;

const CardSide = styled.div`
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  justify-content: space-between;
  font-family: var(--font-mono);
  font-size: 12px;
  & > * + * {
    margin-top: 6px;
  }
`;

// Sortable-header variant: every header is clickable and the active one turns green.
const Table = styled(ScreenerTable)`
  min-width: 760px;
  th {
    cursor: pointer;
    user-select: none;
    &:hover {
      color: rgba(255, 255, 255, 0.8);
    }
    &.sorted {
      color: var(--color-green);
    }
  }
`;

const PairCell = styled.div`
  display: flex;
  align-items: center;
  & > * + * {
    margin-left: 10px;
  }
`;

const PairName = styled.div`
  font-weight: 600;
  small {
    color: rgba(255, 255, 255, 0.4);
    font-weight: 400;
    font-size: 11px;
    margin-left: 6px;
  }
`;

// Row-filter pills (All / My / Liquid / Empty / Favorites). Reuses the SortPill
// look; visible on both desktop and mobile, unlike the mobile-only SortBar.
const FilterBar = styled.div`
  max-width: 1400px;
  margin: 12px auto 0;
  padding: 0 20px;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  & > * {
    margin: 0 6px 6px 0;
  }

  ${MOBILE_MEDIA} {
    padding: 0 12px;
  }
`;

const StarButton = styled.button`
  background: none;
  border: none;
  padding: 4px;
  margin: 0;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  line-height: 0;
  opacity: 0.85;
  &:hover {
    opacity: 1;
  }
  svg {
    display: block;
    width: 16px;
    height: 16px;
  }
`;

interface SortableHeaderProps {
  field: SortKey;
  current: SortKey;
  order: SortOrder;
  onSort: (field: SortKey) => void;
  children: React.ReactNode;
  className?: string;
}

const SortableHeader: React.FC<SortableHeaderProps> = ({ field, current, order, onSort, children, className }) => {
  const isActive = field === current;
  const arrow = isActive ? (order === 'desc' ? ' ▼' : ' ▲') : '';
  return (
    <th className={`${isActive ? 'sorted' : ''} ${className ?? ''}`} onClick={() => onSort(field)}>
      {children}
      {arrow}
    </th>
  );
};

// Row/card extracted and memoized: the list re-renders on every search
// keystroke, favorite toggle, and poll tick, and without the memo all ~500
// rows (icons, sparkline paths, formatted cells) reconcile each time. `fav`
// is passed as a boolean so only the toggled row's props change.
interface PairRowProps {
  p: ApiPair;
  idx: number;
  fav: boolean;
  onOpen: (key: string) => void;
  onToggleFav: (aid1: number, aid2: number) => void;
}

const PairCard = React.memo(({ p, idx, fav, onOpen, onToggleFav }: PairRowProps) => {
  const chg = fmtPct(p.price_change_24h);
  return (
    <Card
      sideColumn
      role="button"
      tabIndex={0}
      onClick={() => onOpen(pairKey(p.aid1, p.aid2))}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen(pairKey(p.aid1, p.aid2));
      }}
    >
      <IconsPair aid1={p.aid1} aid2={p.aid2} />
      <CardMain>
        <CardTopRow>
          <CardTitle>
            {p.symbol1 ?? `aid${p.aid1}`}/{p.symbol2 ?? `aid${p.aid2}`}
          </CardTitle>
          <CardSub>
            #{p.aid2} · #{idx + 1}
          </CardSub>
          <TiersBadge kinds={p.tiers?.map((t) => t.kind) ?? [p.kind]} />
        </CardTopRow>
        <CardStats>
          <CardStat>
            <span>Price</span>
            <span>{p.price_usd !== null ? fmt$(p.price_usd) : fmtPrice(p.price_native)}</span>
          </CardStat>
          <CardStat>
            <span>24h</span>
            <span className={chg.cls}>{chg.text}</span>
          </CardStat>
          <CardStat>
            <span>Vol</span>
            <span>{fmt$(p.volume_24h_usd)}</span>
          </CardStat>
          <CardStat>
            <span>Liq</span>
            <span>{fmt$(p.tvl_usd)}</span>
          </CardStat>
          <CardStat>
            <span>Txns</span>
            <span>
              {p.trades_24h}{' '}
              <span className="positive" style={{ color: 'var(--color-green)' }}>
                {p.buys_24h}
              </span>
              /
              <span className="negative" style={{ color: 'var(--color-red)' }}>
                {p.sells_24h}
              </span>
            </span>
          </CardStat>
        </CardStats>
      </CardMain>
      <CardSide>
        <StarButton
          type="button"
          aria-label="Toggle favorite"
          onClick={(e) => {
            e.stopPropagation();
            onToggleFav(p.aid1, p.aid2);
          }}
        >
          {fav ? <IconFavoriteFilled /> : <IconFavorite />}
        </StarButton>
        <Sparkline values={(p.sparkline_7d ?? []).map((v) => (v > 0 ? 1 / v : 0))} />
      </CardSide>
    </Card>
  );
});

const PairRow = React.memo(({ p, idx, fav, onOpen, onToggleFav }: PairRowProps) => {
  const chg = fmtPct(p.price_change_24h);
  return (
    <tr
      onClick={(e) => {
        // The favorite star handles (and stops) its own clicks; ignore any
        // click that originated inside a button so cell padding stays inert.
        if ((e.target as HTMLElement).closest('button')) return;
        onOpen(pairKey(p.aid1, p.aid2));
      }}
    >
      <td>
        <StarButton
          type="button"
          aria-label="Toggle favorite"
          onClick={(e) => {
            e.stopPropagation();
            onToggleFav(p.aid1, p.aid2);
          }}
        >
          {fav ? <IconFavoriteFilled /> : <IconFavorite />}
        </StarButton>
      </td>
      <td className="neutral">{idx + 1}</td>
      <td>
        <PairCell>
          <IconsPair aid1={p.aid1} aid2={p.aid2} />
          <PairName>
            {p.symbol1 ?? `aid${p.aid1}`}/{p.symbol2 ?? `aid${p.aid2}`}
            <small>#{p.aid2}</small>
          </PairName>
        </PairCell>
      </td>
      <td>
        <TiersBadge kinds={p.tiers?.map((t) => t.kind) ?? [p.kind]} />
      </td>
      <td className="mono">{p.price_usd !== null ? fmt$(p.price_usd) : fmtPrice(p.price_native)}</td>
      <td className={chg.cls}>{chg.text}</td>
      <td className="mono">
        {p.trades_24h} <span className="positive">{p.buys_24h}</span>/<span className="negative">{p.sells_24h}</span>
      </td>
      <td className="mono">{fmt$(p.volume_24h_usd)}</td>
      <td className="mono">{fmt$(p.tvl_usd)}</td>
      <td>
        {/* Invert closes so the trend matches the PRICE column
            (price of aid2). Backend serves raw aid2-per-aid1. */}
        <Sparkline values={(p.sparkline_7d ?? []).map((v) => (v > 0 ? 1 / v : 0))} />
      </td>
    </tr>
  );
});

export const PairsList: React.FC = () => {
  const navigate = useNavigate();
  const [sortBy, setSortBy] = useState<SortKey>('tvl_usd');
  const [order, setOrder] = useState<SortOrder>('desc');
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  // Debounce search input.
  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchInput), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const [filter, setFilter] = useState<DexFilter>('all');
  const [createOpen, setCreateOpen] = useState(false);
  // Render only the active layout's rows. The card (mobile) and table (desktop)
  // lists both map over every pair; without this gate both are in the DOM at
  // all times with one CSS-hidden, doubling the row count — ~8 SVGs per row
  // (icons + sparkline) wasted on the inactive layout. The MobileOnly/
  // DesktopOnly wrappers stay as an instant-visual guard during a resize
  // before the media-query change event fires.
  const isMobile = useIsMobile();
  // MY filter + Create Pool are wallet-only (shown inside the BEAM wallet, hidden
  // on the public web). `inWallet` is isInsideWallet() from walletEnv.
  const { inWallet } = useWallet();
  const { favorites, toggle } = useFavorites();
  const onOpen = useCallback((key: string): void => navigate(`/pair/${key}`), [navigate]);
  // Only poll the AMM shader for "my created pools" while the MY filter is active.
  const { createdKeys } = useMyCreatedPairs(filter === 'mine');

  // The MY pill only exists inside the wallet; fall back to ALL on the web so the
  // list doesn't get stuck showing an empty, unreachable filter.
  React.useEffect(() => {
    if (!inWallet && filter === 'mine') setFilter('all');
  }, [inWallet, filter]);

  const stats = useStats();
  const { data, loading, error } = usePairs(
    useMemo(
      () => ({
        sort_by: sortBy,
        order,
        // 500 == the backend's grouped SQL window, so this pulls every pair —
        // needed for EMPTY (zero-TVL pairs sort to the bottom) to be complete.
        limit: 500,
        group: 'pair' as const,
        ...(debouncedSearch ? { search: debouncedSearch } : {}),
      }),
      [sortBy, order, debouncedSearch],
    ),
  );

  const onSort = (field: SortKey): void => {
    if (field === sortBy) {
      setOrder(order === 'desc' ? 'asc' : 'desc');
    } else {
      setSortBy(field);
      setOrder('desc');
    }
  };

  const pairs: ApiPair[] = data?.pairs ?? [];

  const filtered = useMemo(() => {
    switch (filter) {
      case 'mine':
        return pairs.filter((p) => createdKeys.has(pairKey(p.aid1, p.aid2)));
      case 'liquid':
        return pairs.filter((p) => p.tvl_usd != null && p.tvl_usd > 0);
      case 'empty':
        return pairs.filter((p) => !p.tvl_usd);
      case 'fav':
        return pairs.filter((p) => favorites.has(pairKey(p.aid1, p.aid2)));
      default:
        return pairs;
    }
  }, [pairs, filter, createdKeys, favorites]);

  const filterPills: ReadonlyArray<[DexFilter, string]> = [
    ['all', 'All'],
    ...(inWallet ? [['mine', 'My'] as [DexFilter, string]] : []),
    ['liquid', 'Liquid'],
    ['empty', 'Empty'],
    ['fav', 'Favorites'],
  ];

  const emptyMessage = (() => {
    switch (filter) {
      case 'mine':
        return 'You haven’t created any pairs yet.';
      case 'liquid':
        return 'No pairs with liquidity.';
      case 'empty':
        return 'No empty pairs.';
      case 'fav':
        return 'No favorite pairs yet — tap the ★ to add one.';
      default:
        return 'No pairs found.';
    }
  })();

  return (
    <Page>
      <StatsBar stats={stats.data} />
      <Header>
        <Search
          type="text"
          placeholder="Search pairs (symbol or AID)…"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
        />
        <LpButton to={ROUTES.NAV.LIQUIDITY}>◆ Liquidity Positions</LpButton>
        {inWallet && (
          <CreatePoolBtn type="button" onClick={() => setCreateOpen(true)}>
            + Create Pool
          </CreatePoolBtn>
        )}
      </Header>
      <FilterBar>
        {filterPills.map(([value, label]) => (
          <SortPill key={value} active={filter === value} onClick={() => setFilter(value)}>
            {label}
          </SortPill>
        ))}
      </FilterBar>
      <TableWrap>
        {error ? (
          <CenteredNote>
            Failed to load pairs:
            {error}
          </CenteredNote>
        ) : loading && pairs.length === 0 ? (
          <CenteredNote>Loading pairs…</CenteredNote>
        ) : filtered.length === 0 ? (
          <CenteredNote>{emptyMessage}</CenteredNote>
        ) : (
          <>
            <MobileOnly>
              <SortBar>
                <span>Sort:</span>
                {(
                  [
                    ['tvl_usd', 'Liquidity'],
                    ['volume_24h_usd', 'Volume'],
                    ['price_change_24h', '24h %'],
                    ['trades_24h', 'Txns'],
                  ] as ReadonlyArray<[SortKey, string]>
                ).map(([k, label]) => (
                  <SortPill key={k} active={sortBy === k} onClick={() => onSort(k)}>
                    {label}
                    {sortBy === k ? (order === 'desc' ? ' ▼' : ' ▲') : ''}
                  </SortPill>
                ))}
              </SortBar>
              {isMobile &&
                filtered.map((p, idx) => (
                  <PairCard
                    key={p.pair_id}
                    p={p}
                    idx={idx}
                    fav={favorites.has(pairKey(p.aid1, p.aid2))}
                    onOpen={onOpen}
                    onToggleFav={toggle}
                  />
                ))}
            </MobileOnly>
            <DesktopOnly>
              <Table>
                <thead>
                  <tr>
                    <th style={{ width: 32 }} aria-label="Favorite" />
                    <th style={{ width: 40 }}>#</th>
                    <th>Pair</th>
                    <th style={{ width: 60 }}>Tier</th>
                    <SortableHeader field="aid2" current={sortBy} order={order} onSort={onSort}>
                      Price
                    </SortableHeader>
                    <SortableHeader field="price_change_24h" current={sortBy} order={order} onSort={onSort}>
                      24h
                    </SortableHeader>
                    <SortableHeader field="trades_24h" current={sortBy} order={order} onSort={onSort}>
                      Txns
                    </SortableHeader>
                    <SortableHeader field="volume_24h_usd" current={sortBy} order={order} onSort={onSort}>
                      Volume
                    </SortableHeader>
                    <SortableHeader field="tvl_usd" current={sortBy} order={order} onSort={onSort}>
                      Liquidity
                    </SortableHeader>
                    <th style={{ width: 110 }}>7D</th>
                  </tr>
                </thead>
                <tbody>
                  {!isMobile &&
                    filtered.map((p, idx) => (
                      <PairRow
                        key={p.pair_id}
                        p={p}
                        idx={idx}
                        fav={favorites.has(pairKey(p.aid1, p.aid2))}
                        onOpen={onOpen}
                        onToggleFav={toggle}
                      />
                    ))}
                </tbody>
              </Table>
            </DesktopOnly>
          </>
        )}
      </TableWrap>
      {createOpen && <CreatePoolModal onClose={() => setCreateOpen(false)} />}
    </Page>
  );
};
