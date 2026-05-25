import React, { useState, useMemo } from 'react';
import { styled } from '@linaria/react';
import { useNavigate } from 'react-router-dom';
import { usePairs, useStats } from '../hooks';
import type { ApiPair, SortKey, SortOrder } from '../api/types';
import { StatsBar } from '../components/StatsBar';
import { IconsPair } from '../components/IconsPair';
import { KindBadge } from '../components/KindBadge';
import { Sparkline } from '../components/Sparkline';
import {
  fmt$, fmtPct, fmtPrice, pairUrlId,
} from '../components/format';

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
  gap: 16px;

  @media (max-width: 640px) {
    padding: 0 12px;
    gap: 10px;
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

const TableWrap = styled.div`
  max-width: 1400px;
  margin: 16px auto;
  padding: 0 20px;
  overflow-x: auto;

  @media (max-width: 640px) {
    padding: 0 4px;
  }
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
  gap: 10px;
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

  const stats = useStats();
  const { data, loading, error } = usePairs(
    useMemo(
      () => ({
        sort_by: sortBy,
        order,
        limit: 100,
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
      </Header>
      <TableWrap>
        {error ? (
          <Empty>
            Failed to load pairs:
            {error}
          </Empty>
        ) : loading && pairs.length === 0 ? (
          <Loading>Loading pairs…</Loading>
        ) : pairs.length === 0 ? (
          <Empty>No pairs found.</Empty>
        ) : (
          <Table>
            <thead>
              <tr>
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
              {pairs.map((p, idx) => {
                const chg = fmtPct(p.price_change_24h);
                return (
                  <tr
                    key={p.pair_id}
                    onClick={() => navigate(`/pair/${pairUrlId(p.aid1, p.aid2, p.kind)}`)}
                  >
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
                    <td><KindBadge kind={p.kind} /></td>
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
        )}
      </TableWrap>
    </Page>
  );
};
