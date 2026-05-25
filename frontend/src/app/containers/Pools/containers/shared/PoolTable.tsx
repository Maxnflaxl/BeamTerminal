import React, { useMemo } from 'react';
import { styled } from '@linaria/react';
import { IPoolCard } from '@core/types';
import { fromGroths, getPoolKind, truncate } from '@core/appUtils';
import { poolHasImposterAsset } from '@app/shared/constants';
import { IconFavorite, IconFavoriteFilled } from '@app/shared/icons';
import AssetIcon from '@app/shared/components/AssetsIcon';
import TableScrollViewport from '@app/shared/components/TableScrollViewport';
import { iconButtonReset, rowCenter, warningBadgeBase } from '../../../../styles/linariaShared';

const Table = styled.table`
  width: 100%;
  max-width: 1100px;
  border-collapse: collapse;
  th,
  td {
    text-align: left;
    padding: 10px 8px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  }
  th {
    font-size: 12px;
    text-transform: uppercase;
    color: rgba(255, 255, 255, 0.6);
  }
`;

const FavButton = styled('button')`
  ${iconButtonReset}
`;

const Row = styled.tr`
  cursor: pointer;
`;

const PairCell = styled('div')`
  ${rowCenter}
  gap: 8px;
`;

const PairText = styled('div')`
  ${rowCenter}
  gap: 4px;
`;

const WarningBadge = styled('span')`
  ${warningBadgeBase}
  padding: 1px 6px;
  margin-left: 12px;
`;

const TokenCell = styled('div')`
  ${rowCenter}
  gap: 8px;
`;

const EmptyState = styled.div`
  padding: 24px 8px;
  color: rgba(255, 255, 255, 0.5);
  font-size: 14px;
`;

const DimText = styled.span`
  color: rgba(255, 255, 255, 0.4);
`;

interface PoolTableProps {
  rows: IPoolCard[];
  favorites: IPoolCard[];
  onFavorite: (pool: IPoolCard) => void;
  onOpenTrade: (pool: IPoolCard) => void;
  /** Shown when `rows` is empty; defaults to "No pools found." */
  emptyMessage?: string;
}

const formatNum = (value) => Number(value).toLocaleString('en-US', { maximumFractionDigits: 8 });

export const PoolTable: React.FC<PoolTableProps> = ({
  rows, favorites, onFavorite, onOpenTrade, emptyMessage,
}) => {
  const favoriteSet = useMemo(
    () => new Set((favorites || []).map((item: IPoolCard) => `${item.aid1}-${item.aid2}-${item.kind}`)),
    [favorites],
  );

  if (!rows.length) {
    return <EmptyState>{emptyMessage ?? 'No pools found'}</EmptyState>;
  }

  return (
    <TableScrollViewport tableMinWidth={720}>
      <Table>
        <thead>
          <tr>
            <th>Favorite</th>
            <th>Pair</th>
            <th>Token 1</th>
            <th>Token 2</th>
            <th>Fee Rate</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((pool) => {
            const hasImposterWarning = poolHasImposterAsset(pool.aid1, pool.aid2);
            return (
              <Row
                key={`${pool.aid1}_${pool.aid2}_${pool.kind}`}
                onClick={() => onOpenTrade(pool)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onOpenTrade(pool);
                  }
                }}
                role="button"
                tabIndex={0}
              >
                <td>
                  <FavButton
                    onClick={(e) => {
                      e.stopPropagation();
                      onFavorite(pool);
                    }}
                    type="button"
                    aria-label="Toggle pool favorite"
                  >
                    {favoriteSet.has(`${pool.aid1}-${pool.aid2}-${pool.kind}`)
                      ? <IconFavoriteFilled />
                      : <IconFavorite />}
                  </FavButton>
                </td>
                <td>
                  <PairCell>
                    <AssetIcon asset_id={pool.aid1} />
                    <AssetIcon asset_id={pool.aid2} />
                    <PairText>
                      <span>{truncate(pool.metadata1?.UN || 'Token')}</span>
                      <DimText>{`(id:${pool.aid1})`}</DimText>
                      <span>/</span>
                      <span>{truncate(pool.metadata2?.UN || 'Token')}</span>
                      <DimText>{`(id:${pool.aid2})`}</DimText>
                    </PairText>
                    {hasImposterWarning && <WarningBadge>fake asset</WarningBadge>}
                  </PairCell>
                </td>
                <td>
                  <TokenCell>
                    <AssetIcon asset_id={pool.aid1} />
                    {formatNum(fromGroths(pool.tok1))}
                  </TokenCell>
                </td>
                <td>
                  <TokenCell>
                    <AssetIcon asset_id={pool.aid2} />
                    {formatNum(fromGroths(pool.tok2))}
                  </TokenCell>
                </td>
                <td>{getPoolKind(pool.kind)}</td>
              </Row>
            );
          })}
        </tbody>
      </Table>
    </TableScrollViewport>
  );
};

export default PoolTable;
