import React from 'react';
import { styled } from '@linaria/react';
import { useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import { IAsset } from '@core/types';
import { Container, TableScrollViewport, Window } from '@app/shared/components';
import AssetIcon from '@app/shared/components/AssetsIcon';
import { fromGroths, formatNumber } from '@core/appUtils';
import { isImposterAsset } from '@app/shared/constants';
import { selectAssetsList } from '@app/containers/Pools/store/selectors';
import { warningBadgeBase } from '../../../../styles/linariaShared';

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

const Row = styled.tr`
  cursor: pointer;
  &:hover td {
    background: rgba(255, 255, 255, 0.03);
  }
`;

const DescCell = styled.td`
  max-width: 220px;
  white-space: normal;
  word-break: break-word;
`;

const AssetCell = styled.div`
  display: flex;
  align-items: center;
`;

const AssetName = styled.span`
  font-size: 14px;
  color: white;
`;

const DimText = styled.span`
  font-size: 13px;
  color: rgba(255, 255, 255, 0.5);
`;

const FakeBadge = styled.span`
  ${warningBadgeBase}
  padding: 1px 6px;
  margin-left: 8px;
`;

const EmptyState = styled.div`
  padding: 24px 8px;
  color: rgba(255, 255, 255, 0.5);
  font-size: 14px;
`;

export const Assets = () => {
  const assets: IAsset[] = useSelector(selectAssetsList());
  const navigate = useNavigate();

  return (
    <Window hideHeader>
      <Container>
        {!assets || assets.length === 0 ? (
          <EmptyState>No assets found</EmptyState>
        ) : (
          <TableScrollViewport tableMinWidth={800}>
            <Table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Asset</th>
                  <th>Name</th>
                  <th>Description</th>
                  <th>Emission</th>
                </tr>
              </thead>
              <tbody>
                {assets.map((asset) => {
                  const id = asset.asset_id ?? asset.aid ?? 0;
                  const m = asset.parsedMetadata as any;
                  const ticker = m?.UN || m?.SN || '';
                  const fullName = m?.N || '';
                  const description = m?.OPT_SHORT_DESC || '';
                  const emissionGroths = Number(asset.emission_str ?? asset.emission ?? 0);
                  const emission = emissionGroths > 0 ? formatNumber(fromGroths(emissionGroths)) : '—';
                  return (
                    <Row key={id} onClick={() => navigate(`/asset/${id}`)}>
                      <td>
                        <DimText>{id}</DimText>
                      </td>
                      <td>
                        <AssetCell>
                          <AssetIcon asset_id={id} />
                          <AssetName>{ticker}</AssetName>
                          {isImposterAsset(id) && <FakeBadge>fake</FakeBadge>}
                        </AssetCell>
                      </td>
                      <td>
                        <AssetName>{fullName}</AssetName>
                      </td>
                      <DescCell>
                        <DimText>{description}</DimText>
                      </DescCell>
                      <td>
                        <DimText>{emission}</DimText>
                      </td>
                    </Row>
                  );
                })}
              </tbody>
            </Table>
          </TableScrollViewport>
        )}
      </Container>
    </Window>
  );
};

export default Assets;
