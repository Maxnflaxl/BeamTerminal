import React from 'react';
import { useSelector } from 'react-redux';

import {
  BeamIcon as BeamIconSvg,
  BeamXIcon as BeamXIconSvg,
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

// Generic glyph for every non-branded asset. Rendered inline (not via the
// shared SVGR import) with a PER-INSTANCE gradient id, because a single
// hardcoded id duplicated across 100+ list rows makes `url(#id)` resolve to
// the first copy — and when that first copy's owner SVG has a 0×0 box (as it
// does on list pages) Blink fails to paint the objectBoundingBox gradient for
// every icon, flattening them. Unique ids sidestep the shared resolution
// entirely. React 17 has no useId, so a module counter does the job.
let glyphSeq = 0;

const GenericAssetGlyph: React.FC = () => {
  const gradId = React.useMemo(() => {
    glyphSeq += 1;
    return `assetGlyphGrad${glyphSeq}`;
  }, []);
  return (
    <svg viewBox="0 0 26 26" width="100%" height="100%">
      <defs>
        <radialGradient id={gradId} cx="50%" cy="50%" r="50%" fx="50%" fy="50%">
          <stop offset="0%" stopColor="black" stopOpacity="0" />
          <stop offset="100%" stopColor="black" stopOpacity="0.55" />
        </radialGradient>
      </defs>
      <g fill="none" fillRule="evenodd">
        <circle cx="13" cy="13" r="11.636" fill="currentColor" />
        <circle cx="13" cy="13" r="11.636" fill={`url(#${gradId})`} stroke="currentColor" strokeWidth="2" />
        <g fill="#fff">
          <path
            d="M5.44 0l5.438 8.962H0L5.438 0v2.817L2.664 7.466l2.775-.001 2.776.001L5.44 2.817V0zM3.72 6.923l1.72-2.952 1.72 2.952-1.72-.003-1.72.003z"
            transform="translate(7.150000, 7.540000)"
          />
        </g>
      </g>
    </svg>
  );
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

  const BrandedIcon = ICON_BY_ASSET_ID[asset_id];
  return (
    <ContainerStyled resolvedColor={resolvedColor} size={size} className={className}>
      {BrandedIcon ? <BrandedIcon /> : <GenericAssetGlyph />}
    </ContainerStyled>
  );
};

export default AssetIcon;
