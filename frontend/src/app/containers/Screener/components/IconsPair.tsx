import React from 'react';
import { styled } from '@linaria/react';
import {
  BeamIcon as BeamIconSvg,
  BeamXIcon as BeamXIconSvg,
  AssetIcon as AssetIconSvg,
  IconNPHAsset,
} from '@app/shared/icons';
import {
  BEAM_ID, BEAMX_ID, NPH_ID, PALLETE_ASSETS,
} from '@app/shared/constants';

// Same convention as dex-app's AssetIcon: three brand-specific SVGs,
// everything else uses the generic icon colored from a palette by AID.
const ICON_BY_ASSET_ID: Partial<Record<number, typeof BeamIconSvg>> = {
  [BEAM_ID]: BeamIconSvg,
  [BEAMX_ID]: BeamXIconSvg,
  [NPH_ID]: IconNPHAsset,
};

function colorForAid(aid: number): string {
  return (PALLETE_ASSETS[aid] ?? PALLETE_ASSETS[aid % PALLETE_ASSETS.length]) as string;
}

const Wrap = styled.span`
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  vertical-align: middle;
  gap: 2px;
`;

const Slot = styled.span`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  & svg {
    display: block;
    width: 100%;
    height: 100%;
  }
`;

interface Props {
  aid1: number;
  aid2: number;
  size?: number;
}

export const IconsPair: React.FC<Props> = ({ aid1, aid2, size = 22 }) => {
  const Icon1 = ICON_BY_ASSET_ID[aid1] ?? AssetIconSvg;
  const Icon2 = ICON_BY_ASSET_ID[aid2] ?? AssetIconSvg;
  return (
    <Wrap>
      <Slot style={{ width: size, height: size, color: colorForAid(aid1) }}>
        <Icon1 />
      </Slot>
      <Slot style={{ width: size, height: size, color: colorForAid(aid2) }}>
        <Icon2 />
      </Slot>
    </Wrap>
  );
};
