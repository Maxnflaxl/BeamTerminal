import React, { useState, useMemo } from 'react';
import { styled } from '@linaria/react';
import { useNavigate, Link } from 'react-router-dom';
import { ROUTES } from '@app/shared/constants';
import { usePairs, useStats } from '../hooks';
import type { ApiPair, SortKey, SortOrder } from '../api/types';
import { StatsBar } from '../components/StatsBar';
import { IconsPair } from '../components/IconsPair';
import { TiersBadge } from '../components/KindBadge';
import { Sparkline } from '../components/Sparkline';
import {
  fmt$, fmtPct, fmtPrice, pairKey,
} from '../components/format';
import { useFavorites } from '../favorites';
import { useMyCreatedPairs, useWallet } from '../wallet';
import { CreatePoolModal } from '../components/CreatePoolModal';
import IconFavorite from '@app/shared/icons/icon-favorite.svg';
import IconFavoriteFilled from '@app/shared/icons/icon-favorite-filled.svg';

// DEX-page row filters. `mine` (pairs the connected wallet created) is sourced
// from the AMM shader and only offered when a wallet is connected; the rest are
// derived from the public pairs feed + localStorage favorites.
type DexFilter = 'all' | 'mine' | 'liquid' | 'empty' | 'fav';

const Page = styled.div`
  width: 100%;
  min-height: calc(100vh - 130px);
`;

const Header = styled.div`
  max-width: 1400px;
  margin: 16px auto 0;
  padding: 0 20px;
  display: flex;
  align-items: center;
  & > * + * { margin-left: 16px; }

  @media (max-width: 640px) {
    padding: 0 12px;
    & > * + * { margin-left: 10px; }
  }
`;

const Search = styled.input`
  flex: 1;
  max-width: 400px;
  padding: 8px 12px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  color: white;
  font-size: 13px;
  outline: none;
  font-family: inherit;
  &:focus {
    border-color: var(--color-green);
  }
`;

const LpButton = styled(Link)`
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  & > * + * { margin-left: 6px; }
  padding: 8px 14px;
  background: rgba(0, 246, 210, 0.12);
  border: 1px solid rgba(0, 246, 210, 0.45);
  border-radius: 8px;
  color: #00f6d2;
  font-size: 13px;
  text-decoration: none;
  white-space: nowrap;
  transition: background 120ms, border-color 120ms;
  &:hover { background: rgba(0, 246, 210, 0.22); }

  @media (max-width: 640px) {
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
  &:hover { filter: brightness(1.08); }

  @media (max-width: 640px) {
    font-size: 12px;
    padding: 8px 10px;
  }
`;

const TableWrap = styled.div`
  max-width: 1400px;
  margin: 16px auto;
  padding: 0 20px;
  overflow-x: auto;

  @media (max-width: 640px) {
    padding: 0 12px;
    overflow-x: visible;
  }
`;

const DesktopOnly = styled.div`
  @media (max-width: 640px) { display: none; }
`;

const MobileOnly = styled.div`
  display: none;
  @media (max-width: 640px) { display: block; }
`;

const SortBar = styled.div`
  display: flex;
  & > * + * { margin-left: 6px; }
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

const Card = styled.div`
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 10px;
  padding: 12px;
  margin-bottom: 8px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 10px;
  cursor: pointer;
  &:hover { background: rgba(255, 255, 255, 0.05); }
`;

const CardMain = styled.div`
  min-width: 0;
  display: flex;
  flex-direction: column;
  & > * + * { margin-top: 4px; }
`;

const CardTopRow = styled.div`
  display: flex;
  align-items: baseline;
  & > * + * { margin-left: 8px; }
  flex-wrap: wrap;
`;

const CardTitle = styled.div`
  font-weight: 600;
  font-size: 14px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;

const CardSub = styled.div`
  color: rgba(255, 255, 255, 0.5);
  font-size: 11px;
`;

const CardStats = styled.div`
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 2px 12px;
  margin-top: 4px;
  font-family: 'SFProDisplay', monospace;
  font-size: 12px;
`;

const CardStat = styled.div`
  display: flex;
  justify-content: space-between;
  color: rgba(255, 255, 255, 0.8);

  & > span:first-child {
    color: rgba(255, 255, 255, 0.45);
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin-right: 8px;
  }
`;

const CardSide = styled.div`
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  justify-content: space-between;
  font-family: 'SFProDisplay', monospace;
  font-size: 12px;
  & > * + * { margin-top: 6px; }
`;

const Table = styled.table`
  width: 100%;
  min-width: 760px;
  border-collapse: collapse;
  font-size: 14px;

  th {
    text-align: left;
    padding: 10px 12px;
    font-size: 11px;
    color: rgba(255, 255, 255, 0.5);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    white-space: nowrap;
    cursor: pointer;
    user-select: none;
    &:hover {
      color: rgba(255, 255, 255, 0.8);
    }
    &.sorted {
      color: var(--color-green);
    }
  }
  td {
    padding: 10px 12px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.04);
    vertical-align: middle;
  }
  tbody tr {
    cursor: pointer;
    transition: background 0.15s;
    &:hover {
      background: rgba(255, 255, 255, 0.03);
    }
  }
  .mono {
    font-family: 'SFProDisplay', monospace;
  }
  .positive {
    color: var(--color-green);
  }
  .negative {
    color: var(--color-red);
  }
  .neutral {
    color: rgba(255, 255, 255, 0.5);
  }
`;

const PairCell = styled.div`
  display: flex;
  align-items: center;
  & > * + * { margin-left: 10px; }
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

const Loading = styled.div`
  text-align: center;
  padding: 60px 20px;
  color: rgba(255, 255, 255, 0.5);
`;

const Empty = styled.div`
  text-align: center;
  padding: 60px 20px;
  color: rgba(255, 255, 255, 0.5);
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
  & > * { margin: 0 6px 6px 0; }

  @media (max-width: 640px) {
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
  &:hover { opacity: 1; }
  svg { display: block; width: 16px; height: 16px; }
`;

interface SortableHeaderProps {
  field: SortKey;
  current: SortKey;
  order: SortOrder;
  onSort: (field: SortKey) => void;
  children: React.ReactNode;
  className?: string;
}

const SortableHeader: React.FC<SortableHeaderProps> = ({
  field, current, order, onSort, children, className,
}) => {
  const isActive = field === current;
  const arrow = isActive ? (order === 'desc' ? ' ▼' : ' ▲') : '';
  return (
    <th
      className={`${isActive ? 'sorted' : ''} ${className ?? ''}`}
      onClick={() => onSort(field)}
    >
      {children}
      {arrow}
    </th>
  );
};

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
  // MY filter + Create Pool are wallet-only (shown inside the BEAM wallet, hidden
  // on the public web). `inWallet` is isInsideWallet() from walletEnv.
  const { inWallet } = useWallet();
  const { favorites, toggle } = useFavorites();
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
      case 'mine': return pairs.filter((p) => createdKeys.has(pairKey(p.aid1, p.aid2)));
      case 'liquid': return pairs.filter((p) => p.tvl_usd != null && p.tvl_usd > 0);
      case 'empty': return pairs.filter((p) => !p.tvl_usd);
      case 'fav': return pairs.filter((p) => favorites.has(pairKey(p.aid1, p.aid2)));
      default: return pairs;
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
      case 'mine': return 'You haven’t created any pairs yet.';
      case 'liquid': return 'No pairs with liquidity.';
      case 'empty': return 'No empty pairs.';
      case 'fav': return 'No favorite pairs yet — tap the ★ to add one.';
      default: return 'No pairs found.';
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
          <CreatePoolBtn type="button" onClick={() => setCreateOpen(true)}>+ Create Pool</CreatePoolBtn>
        )}
      </Header>
      <FilterBar>
        {filterPills.map(([value, label]) => (
          <SortPill
            key={value}
            active={filter === value}
            onClick={() => setFilter(value)}
          >
            {label}
          </SortPill>
        ))}
      </FilterBar>
      <TableWrap>
        {error ? (
          <Empty>
            Failed to load pairs:
            {error}
          </Empty>
        ) : loading && pairs.length === 0 ? (
          <Loading>Loading pairs…</Loading>
        ) : filtered.length === 0 ? (
          <Empty>{emptyMessage}</Empty>
        ) : (
          <>
          <MobileOnly>
            <SortBar>
              <span>Sort:</span>
              {([
                ['tvl_usd', 'Liquidity'],
                ['volume_24h_usd', 'Volume'],
                ['price_change_24h', '24h %'],
                ['trades_24h', 'Txns'],
              ] as ReadonlyArray<[SortKey, string]>).map(([k, label]) => (
                <SortPill
                  key={k}
                  active={sortBy === k}
                  onClick={() => onSort(k)}
                >
                  {label}
                  {sortBy === k ? (order === 'desc' ? ' ▼' : ' ▲') : ''}
                </SortPill>
              ))}
            </SortBar>
            {filtered.map((p, idx) => {
              const chg = fmtPct(p.price_change_24h);
              return (
                <Card
                  key={p.pair_id}
                  onClick={() => navigate(`/pair/${pairKey(p.aid1, p.aid2)}`)}
                >
                  <IconsPair aid1={p.aid1} aid2={p.aid2} />
                  <CardMain>
                    <CardTopRow>
                      <CardTitle>
                        {p.symbol1 ?? `aid${p.aid1}`}/{p.symbol2 ?? `aid${p.aid2}`}
                      </CardTitle>
                      <CardSub>#{p.aid2} · #{idx + 1}</CardSub>
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
                          <span className="positive" style={{ color: 'var(--color-green)' }}>{p.buys_24h}</span>
                          /
                          <span className="negative" style={{ color: 'var(--color-red)' }}>{p.sells_24h}</span>
                        </span>
                      </CardStat>
                    </CardStats>
                  </CardMain>
                  <CardSide>
                    <StarButton
                      type="button"
                      aria-label="Toggle favorite"
                      onClick={(e) => { e.stopPropagation(); toggle(p.aid1, p.aid2); }}
                    >
                      {favorites.has(pairKey(p.aid1, p.aid2)) ? <IconFavoriteFilled /> : <IconFavorite />}
                    </StarButton>
                    <Sparkline values={(p.sparkline_7d ?? []).map((v) => (v > 0 ? 1 / v : 0))} />
                  </CardSide>
                </Card>
              );
            })}
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
              {filtered.map((p, idx) => {
                const chg = fmtPct(p.price_change_24h);
                return (
                  <tr
                    key={p.pair_id}
                    onClick={() => navigate(`/pair/${pairKey(p.aid1, p.aid2)}`)}
                  >
                    <td onClick={(e) => e.stopPropagation()}>
                      <StarButton
                        type="button"
                        aria-label="Toggle favorite"
                        onClick={(e) => { e.stopPropagation(); toggle(p.aid1, p.aid2); }}
                      >
                        {favorites.has(pairKey(p.aid1, p.aid2)) ? <IconFavoriteFilled /> : <IconFavorite />}
                      </StarButton>
                    </td>
                    <td className="neutral">{idx + 1}</td>
                    <td>
                      <PairCell>
                        <IconsPair aid1={p.aid1} aid2={p.aid2} />
                        <PairName>
                          {p.symbol1 ?? `aid${p.aid1}`}
                          /
                          {p.symbol2 ?? `aid${p.aid2}`}
                          <small>
                            #
                            {p.aid2}
                          </small>
                        </PairName>
                      </PairCell>
                    </td>
                    <td><TiersBadge kinds={p.tiers?.map((t) => t.kind) ?? [p.kind]} /></td>
                    <td className="mono">
                      {p.price_usd !== null ? fmt$(p.price_usd) : fmtPrice(p.price_native)}
                    </td>
                    <td className={chg.cls}>{chg.text}</td>
                    <td className="mono">
                      {p.trades_24h}
                      {' '}
                      <span className="positive">{p.buys_24h}</span>
                      /
                      <span className="negative">{p.sells_24h}</span>
                    </td>
                    <td className="mono">{fmt$(p.volume_24h_usd)}</td>
                    <td className="mono">{fmt$(p.tvl_usd)}</td>
                    <td>
                      {/* Invert closes so the trend matches the PRICE column
                          (price of aid2). Backend serves raw aid2-per-aid1. */}
                      <Sparkline
                        values={(p.sparkline_7d ?? []).map((v) => (v > 0 ? 1 / v : 0))}
                      />
                    </td>
                  </tr>
                );
              })}
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
