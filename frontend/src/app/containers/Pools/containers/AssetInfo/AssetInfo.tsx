import React, { useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { styled } from '@linaria/react';
import { useDispatch, useSelector } from 'react-redux';
import { IOptions } from '@core/types';
import {
  assetShortLabel, fromGroths, getFilterPools, onFilter,
} from '@core/appUtils';
import { ASSET_BEAM, ROUTES, getRealAssetIdForFake } from '@app/shared/constants';
import {
  Container, Window,
} from '@app/shared/components';
import {
  selectAssetsList, selectFavorites, selectFilter, selectPoolsList,
} from '@app/containers/Pools/store/selectors';
import * as mainActions from '@app/containers/Pools/store/actions';
import AssetIcon from '@app/shared/components/AssetsIcon';
import { AngleBackIcon } from '@app/shared/icons';
import { PoolTable } from '@app/containers/Pools/containers/shared/PoolTable';

const PageLayout = styled.div`
  display: flex;
  width: 100%;
  max-width: 1100px;
  align-items: flex-start;
`;

const BackCol = styled.div`
  width: 80px;
  flex-shrink: 0;
  padding-top: 20px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  margin-right: 60px;
`;

const MainCol = styled.div`
  flex: 1;
  min-width: 0;
`;

const AssetCard = styled.div`
  display: flex;
  flex-direction: column;
  padding: 20px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 18px;
  margin-bottom: 20px;
`;

const AssetHeader = styled.div`
  display: flex;
  align-items: center;
  margin-bottom: 16px;
  padding-bottom: 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
`;

const IconWrap = styled.div`
  width: 48px;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  margin-right: 6px;
  background: rgba(255, 255, 255, 0.05);
  border-radius: 50%;
`;

/** 32×32 glyph in the 48px circle (default AssetIcon is 18×18). */
const HeaderAssetIcon = styled(AssetIcon)`
  width: 32px;
  height: 32px;
  margin-right: 0;

  & svg {
    display: block;
    width: 32px;
    height: 32px;
  }
`;

const AssetHeaderText = styled.div`
  min-width: 0;
`;

const AssetFullName = styled.div`
  font-size: 18px;
  font-weight: 700;
  color: white;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;

const AssetTickerBadge = styled.div`
  font-size: 13px;
  font-weight: 700;
  text-transform: uppercase;
  color: rgba(255, 255, 255, 0.45);
  letter-spacing: 0.8px;
  margin-top: 2px;
`;

const InfoGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 0;

  @media (max-width: 600px) {
    grid-template-columns: 1fr;
  }
`;

const InfoCell = styled.div`
  padding: 10px 12px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);

  &:nth-child(odd) {
    border-right: 1px solid rgba(255, 255, 255, 0.06);
  }
`;

const InfoLabel = styled.div`
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.8px;
  color: rgba(255, 255, 255, 0.4);
  margin-bottom: 4px;
`;

const InfoValue = styled.div`
  font-size: 14px;
  font-weight: 600;
  color: white;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const SectionTitle = styled.div`
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 1.5px;
  color: rgba(255, 255, 255, 0.6);
  margin-bottom: 10px;
`;

const NotFound = styled.div`
  color: rgba(255, 255, 255, 0.5);
  font-size: 16px;
  padding: 40px 0;
  text-align: center;
`;

const BackButton = styled.button`
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 37px;
  padding: 0 14px;
  background: rgba(255, 255, 255, 0.1);
  border: none;
  border-radius: 19px;
  color: white;
  font-weight: 700;
  font-size: 14px;
  font-family: 'ProximaNova', 'SFProDisplay', sans-serif;
  cursor: pointer;
  white-space: nowrap;

  &:hover {
    background: rgba(255, 255, 255, 0.3);
  }
`;

const DescBlock = styled.div`
  padding: 10px 12px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
`;

const SiteLink = styled.a`
  color: var(--color-green);
  font-size: 13px;
  font-weight: 600;
  text-decoration: none;
  word-break: break-all;
  &:hover { text-decoration: underline; }
`;

const WarningCard = styled.div`
  margin-top: 14px;
  padding: 12px;
  border: 1px solid rgba(255, 95, 95, 0.55);
  background: rgba(255, 95, 95, 0.1);
  border-radius: 10px;
`;

const WarningTitle = styled.div`
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: #ff5f5f;
  margin-bottom: 6px;
`;

const WarningText = styled.div`
  color: rgba(255, 255, 255, 0.92);
  font-size: 13px;
  line-height: 1.5;
`;

const WarningAction = styled.button`
  margin-top: 10px;
  height: 34px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  background: rgba(255, 255, 255, 0.06);
  color: white;
  border-radius: 17px;
  padding: 0 12px;
  font-weight: 700;
  font-size: 12px;
  cursor: pointer;
`;

export const AssetInfo = () => {
  const { id } = useParams<{ id: string }>();
  const assetId = parseInt(id, 10);
  const navigate = useNavigate();
  const dispatch = useDispatch();

  const assetsList = useSelector(selectAssetsList());
  const pools = useSelector(selectPoolsList());
  const favorites = useSelector(selectFavorites());
  const currentFilter = useSelector(selectFilter());

  const asset = useMemo(() => {
    if (assetId === 0) {
      return {
        asset_id: 0,
        parsedMetadata: ASSET_BEAM,
        metadata: '',
        owner_pk: '',
      };
    }
    return (assetsList || []).find((a) => (a.asset_id ?? (a as any).aid) === assetId);
  }, [assetId, assetsList]);

  const filteredRows = useMemo(() => {
    if (!asset) return [];
    const assetOption: IOptions = {
      value: assetId,
      label: assetShortLabel(asset.parsedMetadata as any),
    };
    return getFilterPools(assetOption, onFilter(pools, currentFilter, favorites)) || [];
  }, [asset, assetId, pools, currentFilter, favorites]);

  const onOpenTrade = (pool) => {
    dispatch(mainActions.setCurrentPool(pool));
    dispatch(mainActions.setPredict(null));
    navigate(ROUTES.NAV.TRADE);
  };

  const handleFavorite = (pool) => {
    dispatch(mainActions.onFavorites.request(pool));
  };

  if (!asset) {
    return (
      <Window hideHeader>
        <Container>
          <NotFound>Asset not found.</NotFound>
        </Container>
      </Window>
    );
  }

  const m = asset.parsedMetadata as any;
  const fullName = m?.UN || m?.N || 'Unknown Asset';
  const ticker = assetShortLabel(m);
  const supplyGroths = assetId === 0 ? 0 : Number((asset as any).emission_str ?? (asset as any).emission ?? 0);
  const supply = assetId === 0 ? null : fromGroths(supplyGroths);

  const infoFields: Array<{ label: string; value: string | number | null }> = [
    { label: 'Asset ID', value: assetId },
    { label: 'Ticker', value: ticker || null },
    { label: 'Full Name', value: m?.N || null },
    { label: 'Smallest Unit', value: m?.NTHUN || null },
    { label: 'Total Supply', value: supply !== null ? `${Number(supply).toLocaleString('en-US', { maximumFractionDigits: 4 })} ${ticker}` : null },
    { label: 'Schema Ver.', value: m?.SCH_VER || null },
  ].filter((f) => f.value !== null && f.value !== '');

  const longDesc = (m as any)?.OPT_LONG_DESC || null;
  const siteUrl = (m as any)?.OPT_SITE_URL || null;
  const realAssetId = getRealAssetIdForFake(assetId);

  return (
    <Window hideHeader>
      <Container>
        <PageLayout>
          <BackCol>
            <BackButton type="button" onClick={() => navigate(-1)}>
              <AngleBackIcon />
              Back
            </BackButton>
          </BackCol>

          <MainCol>
            <AssetCard>
              <AssetHeader>
                <IconWrap>
                  <HeaderAssetIcon asset_id={assetId} />
                </IconWrap>
                <AssetHeaderText>
                  <AssetFullName>{fullName}</AssetFullName>
                  {ticker !== fullName && <AssetTickerBadge>{ticker}</AssetTickerBadge>}
                </AssetHeaderText>
              </AssetHeader>

              <InfoGrid>
                {infoFields.map((field) => (
                  <InfoCell key={field.label}>
                    <InfoLabel>{field.label}</InfoLabel>
                    <InfoValue title={String(field.value)}>{field.value}</InfoValue>
                  </InfoCell>
                ))}
              </InfoGrid>

              {longDesc && (
                <DescBlock>
                  <InfoLabel>Description</InfoLabel>
                  <InfoValue style={{ whiteSpace: 'pre-wrap', overflow: 'visible', wordBreak: 'break-word' }}>{longDesc}</InfoValue>
                </DescBlock>
              )}
              {siteUrl && (
                <DescBlock>
                  <InfoLabel>Website</InfoLabel>
                  <SiteLink href={siteUrl} target="_blank" rel="noopener noreferrer">{siteUrl}</SiteLink>
                </DescBlock>
              )}
              {realAssetId !== null && (
                <WarningCard>
                  <WarningTitle>Imposter asset warning</WarningTitle>
                  <WarningText>
                    {`Asset id ${assetId} is marked as an imposter.`}
                    {' '}
                    {`The real asset id is ${realAssetId}.`}
                  </WarningText>
                  <WarningAction type="button" onClick={() => navigate(`/asset/${realAssetId}`)}>
                    Open real asset info
                  </WarningAction>
                </WarningCard>
              )}
            </AssetCard>

            <SectionTitle>Pools</SectionTitle>
            <PoolTable
              rows={filteredRows}
              favorites={favorites || []}
              onFavorite={handleFavorite}
              onOpenTrade={onOpenTrade}
            />
          </MainCol>
        </PageLayout>
      </Container>
    </Window>
  );
};

export default AssetInfo;
