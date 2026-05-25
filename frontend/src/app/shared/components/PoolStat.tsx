import React from 'react';
import { useNavigate } from 'react-router-dom';
import { IAsset, IPoolCard } from '@core/types';
import { Section } from '@app/shared/components/index';
import AssetLabel from '@app/shared/components/AssetLabel';
import {
  fromGroths, truncate, formatNumber, getPoolKind,
} from '@core/appUtils';
import { styled } from '@linaria/react';
import { useDispatch, useSelector } from 'react-redux';
import { IconFavorite, IconFavoriteFilled } from '@app/shared/icons';
import * as mainActions from '@app/containers/Pools/store/actions';
import { selectFavorites } from '@app/containers/Pools/store/selectors';

interface PoolStatType {
  data: IPoolCard;
  lp: IAsset;
  showFavorite?: boolean;
  plain?: boolean;
}

const AmountWrapper = styled.div`
  display: flex;
  width: 100%;
  height: 100px;
  justify-content: flex-start;
  margin-bottom: 20px;
`;
const AssetAmount = styled.div`
  font-weight: 400;
  font-size: 14px;
  line-height: 17px;
  color: white;
`;
const SideLeftWrap = styled.div`
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  align-items: flex-start;
  width: 100%;
`;
const SideRightWrap = styled.div`
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  align-items: flex-end;
  width: 100%;
`;
const HeaderMeta = styled('div')`
  display: flex;
  align-items: center;
  margin-left: auto;
  justify-content: flex-end;
  flex-wrap: nowrap;
  gap: 8px;
`;
const FeeBadge = styled.div`
  margin: 0;
  background: rgba(255, 255, 255, 0.05);
  padding: 4px 8px;
  border-radius: 20px;
  font-weight: 400;
  font-size: 14px;
  line-height: 14px;
  color: white;
`;
const FavoriteButton = styled('button')`
  border: none;
  background: transparent;
  margin: 0;
  padding: 0;
  line-height: 0;
  cursor: pointer;
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  & svg {
    display: block;
  }
`;
const PlainWrapper = styled.div`
  width: 100%;
`;
const PlainHeader = styled.div`
  width: 100%;
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
`;
const PlainTitle = styled.div`
  font-weight: 700;
  font-size: 14px;
  line-height: 17px;
  letter-spacing: 3px;
  text-transform: uppercase;
  color: var(--color-white);
`;
const AssetInfoLink = styled.div`
  cursor: pointer;
`;

const PoolStat = ({
  data, lp, showFavorite = false, plain = false,
}: PoolStatType) => {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const favorites = useSelector(selectFavorites());
  const nameToken1 = truncate(data?.metadata1?.UN || `Token ${data?.aid1 ?? ''}`);
  const nameToken2 = truncate(data?.metadata2?.UN || `Token ${data?.aid2 ?? ''}`);
  const nameLPToken = lp?.parsedMetadata?.UN ? truncate(lp.parsedMetadata.UN) : 'AMML';
  const lpId = lp ? lp.aid : data['lp-token'];
  const favoriteKey = `${data.aid1}-${data.aid2}-${data.kind}`;
  const isFavorite = (favorites || []).some((item) => `${item.aid1}-${item.aid2}-${item.kind}` === favoriteKey);

  const content = (
    <>
      <AmountWrapper>
        <SideLeftWrap>
          <AssetInfoLink onClick={() => navigate(`/asset/${data.aid1}`)}>
            <AssetLabel title={nameToken1} assets_id={data.aid1} id variant="predict" />
          </AssetInfoLink>
          <AssetInfoLink onClick={() => navigate(`/asset/${data.aid2}`)}>
            <AssetLabel title={nameToken2} assets_id={data.aid2} id variant="predict" />
          </AssetInfoLink>
          <AssetInfoLink onClick={() => navigate(`/asset/${lpId}`)}>
            <AssetLabel title={nameLPToken} assets_id={lpId} id variant="predict" />
          </AssetInfoLink>
        </SideLeftWrap>
        <SideRightWrap>
          <AssetAmount>{formatNumber(fromGroths(data.tok1))}</AssetAmount>
          <AssetAmount>{formatNumber(fromGroths(data.tok2))}</AssetAmount>
          <AssetAmount>{formatNumber(fromGroths(data.ctl))}</AssetAmount>
        </SideRightWrap>
      </AmountWrapper>
    </>
  );

  if (plain) {
    return (
      <PlainWrapper>
        <PlainHeader>
          <PlainTitle>Pool info</PlainTitle>
          <HeaderMeta>
            <FeeBadge>{getPoolKind(data.kind) || '--'}</FeeBadge>
            {showFavorite && (
            <FavoriteButton type="button" onClick={() => dispatch(mainActions.onFavorites.request(data))}>
              {isFavorite ? <IconFavoriteFilled /> : <IconFavorite />}
            </FavoriteButton>
            )}
          </HeaderMeta>
        </PlainHeader>
        {content}
      </PlainWrapper>
    );
  }

  return (
    <Section
      title="Pool info"
      headerRight={(
        <HeaderMeta>
          <FeeBadge>{getPoolKind(data.kind) || '--'}</FeeBadge>
          {showFavorite && (
            <FavoriteButton type="button" onClick={() => dispatch(mainActions.onFavorites.request(data))}>
              {isFavorite ? <IconFavoriteFilled /> : <IconFavorite />}
            </FavoriteButton>
          )}
        </HeaderMeta>
      )}
    >
      {content}
    </Section>
  );
};

export default PoolStat;
