import React from 'react';
import { styled } from '@linaria/react';
import AssetIcon from '@app/shared/components/AssetsIcon';
import { fromGroths, formatNumber } from '@core/appUtils';

interface AssetLabeProps {
  title?: string;
  assets_id: number;
  amount?: number;
  variant?: 'regular' | 'predict';
  id?: boolean;
}
// TODO: LABEL POSITION
const AssetStyled = styled.div`
  //max-width: 110px;
  //width: 100%;
  display: flex;
  align-items: center;
  justify-content: flex-end;
`;
const RegularTitleStyled = styled.span`
  font-style: normal;
  font-weight: 400;
  font-size: 20px;
  line-height: 20px;
  color: rgba(255, 255, 255, 0.7);
  text-transform: uppercase;
`;
export const Amount = styled(RegularTitleStyled)`
  font-style: normal;
  font-weight: 400;
  font-size: 14px;
  line-height: 14px;
  color: var(--color-white);
  text-transform: uppercase;
  margin-right: 4px;
`;

export const PredictTitleStyled = styled(RegularTitleStyled)`
  font-weight: 400;
  font-size: 14px;
  line-height: 14px;
  color: var(--color-white);
`;
export const AssetsId = styled(PredictTitleStyled)`
  display: inline-flex;
  margin-left: 4px;
  color: rgba(255, 255, 255, 0.7);
  text-transform: lowercase;
`;

const TitleIdGroup = styled.span`
  display: inline-flex;
  flex-wrap: nowrap;
  align-items: center;
  min-width: 0;
`;

const IdBesideTitle = styled(AssetsId)`
  margin-left: 6px;
  line-height: inherit;
`;
// const AssetsId = styled.h5`
//   display: flex;
//   color: rgba(255,255,255, 0.7);
// `;
const AssetLabel = ({
  title, assets_id, amount, variant = 'regular', id = true,
}: AssetLabeProps) => {
  const TitleComponent = {
    regular: RegularTitleStyled,
    predict: PredictTitleStyled,
  }[variant];

  return (
    <AssetStyled variant={variant}>
      <AssetIcon asset_id={assets_id} />
      {amount >= 0 && <Amount>{formatNumber(fromGroths(amount))}</Amount>}
      <TitleIdGroup>
        <TitleComponent>{title}</TitleComponent>
        {id && <IdBesideTitle>{`(id:${assets_id})`}</IdBesideTitle>}
      </TitleIdGroup>
    </AssetStyled>
  );
};

export default AssetLabel;
