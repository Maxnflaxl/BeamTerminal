import React from 'react';
import { useSelector } from 'react-redux';

import {
  BeamIcon as BeamIconSvg,
  BeamXIcon as BeamXIconSvg,
  AssetIcon as AssetIconSvg,
  IconNPHAsset,
} from '@app/shared/icons';

import { styled } from '@linaria/react';
import {
  BEAM_ID, BEAMX_ID, PALLETE_ASSETS, NPH_ID,
} from '@app/shared/constants';
import { selectAssetsList } from '@app/containers/Pools/store/selectors';
import { IAsset } from '@core/types';

// Inlined rather than imported from appUtils to avoid pulling that module's
// transitive dependency on the entry-point store default export (TDZ).
function normalizeOptColor(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const hex = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;
  if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
  if (hex.length !== 3 && hex.length !== 4 && hex.length !== 6 && hex.length !== 8) return null;
  return `#${hex.toLowerCase()}`;
}

export interface AssetIconProps {
  asset_id?: number;
  className?: string;
  /** Side length in px applied to both the wrapper and the inner SVG. The
   *  SVG's viewBox is 0 0 26 26 and its radial gradient + stroke use
   *  proportional units, so any pixel size scales cleanly. */
  size?: number;
}

const ICON_BY_ASSET_ID: Partial<Record<number, typeof BeamIconSvg>> = {
  [BEAM_ID]: BeamIconSvg,
  [BEAMX_ID]: BeamXIconSvg,
  [NPH_ID]: IconNPHAsset,
};

interface ContainerStyledProps {
  resolvedColor: string;
  size: number;
  className?: string;
}

const ContainerStyled = styled.div<ContainerStyledProps>`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  vertical-align: middle;
  width: ${({ size }) => size}px;
  height: ${({ size }) => size}px;
  margin-right: 10px;
  color: ${({ resolvedColor }) => resolvedColor};
  & svg {
    display: block;
    width: 100%;
    height: 100%;
  }
`;

function paletteColor(asset_id: number): string {
  return PALLETE_ASSETS[asset_id] ?? PALLETE_ASSETS[asset_id % PALLETE_ASSETS.length];
}

const AssetIcon: React.FC<AssetIconProps> = ({ asset_id = 0, className, size = 22 }) => {
  const assets = useSelector(selectAssetsList()) as IAsset[];
  const asset = assets?.find((a) => (a.asset_id ?? a.aid) === asset_id);
  const metadataColor = normalizeOptColor(asset?.parsedMetadata?.OPT_COLOR);
  const resolvedColor = metadataColor ?? paletteColor(asset_id);

  const IconComponent = ICON_BY_ASSET_ID[asset_id] ?? AssetIconSvg;
  return (
    <ContainerStyled resolvedColor={resolvedColor} size={size} className={className}>
      <IconComponent />
    </ContainerStyled>
  );
};

export default AssetIcon;
