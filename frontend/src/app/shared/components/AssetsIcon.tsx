import React from 'react';
import { useSelector } from 'react-redux';

import {
  BeamIcon as BeamIconSvg,
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

// Per-instance gradient id counter. The shared SVGR icons bake a single
// hardcoded gradient id; duplicated across 100+ list rows, every `url(#id)`
// resolves to the first copy, and when that first copy's owner SVG has a 0×0
// box (as it does on list pages) Blink fails to paint the gradient for every
// icon — flattening them / dropping borders. Inlining the affected glyphs
// with a unique id per instance sidesteps the shared resolution. React 17 has
// no useId, so a module counter does the job.
let glyphSeq = 0;

// BeamX icon, inlined for the same reason as GenericAssetGlyph: its border is
// stroked with a linear gradient referenced by a shared id, which vanishes on
// list pages where the first definition's owner SVG has a degenerate box. The
// per-instance id keeps the border ring visible everywhere.
const BeamXGlyph: React.FC = () => {
  const gradId = React.useMemo(() => {
    glyphSeq += 1;
    return `beamxBorderGrad${glyphSeq}`;
  }, []);
  return (
    <svg viewBox="0 0 18 18" width="100%" height="100%" fill="none" preserveAspectRatio="xMidYMid meet">
      <path d="M17 9C17 13.4183 13.4183 17 9 17C4.58172 17 1 13.4183 1 9C1 4.58172 4.58172 1 9 1C13.4183 1 17 4.58172 17 9Z" fill="#000A16" stroke={`url(#${gradId})`} strokeWidth="2" />
      <path transform="translate(-0.15 0.4)" d="M9.19053 3.71924L13.6439 11.1166H4.73535L9.19053 3.71924ZM9.1901 6.16284L6.93269 9.90024H11.4466L9.1901 6.16284Z" fill="#0B76FF" />
      <path transform="translate(-0.15 0.4)" d="M9.18887 13.5713L4.73545 6.17389L13.644 6.17389L9.18887 13.5713ZM9.1893 11.1277L11.4467 7.39029L6.93278 7.39029L9.1893 11.1277Z" fill="#00E3C2" style={{ mixBlendMode: 'lighten' }} />
      <path transform="translate(-0.15 0.4)" d="M6.78414 4.4487L14.2775 8.42554L6.43836 13.015L6.78414 4.4487ZM7.96456 6.52048L7.78413 10.8518L11.7562 8.52635L7.96456 6.52048Z" fill="#25C0FF" />
      <path transform="translate(-0.15 0.4)" d="M11.5843 12.8462L4.09086 8.86939L11.93 4.27989L11.5843 12.8462ZM10.4038 10.7744L10.5843 6.44311L6.61222 8.76858L10.4038 10.7744Z" fill="#FF51FF" style={{ mixBlendMode: 'lighten' }} />
      <defs>
        <linearGradient id={gradId} x1="9" y1="0" x2="9" y2="18" gradientUnits="userSpaceOnUse">
          <stop stopColor="#A17DFF" />
          <stop offset="1" stopColor="#6F7FFF" />
        </linearGradient>
      </defs>
    </svg>
  );
};

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

// Asset id → branded glyph. Declared here (after the glyph components) so the
// const references aren't hit before initialization at module load.
const ICON_BY_ASSET_ID: Partial<Record<number, React.FC>> = {
  [BEAM_ID]: BeamIconSvg,
  [BEAMX_ID]: BeamXGlyph,
  [NPH_ID]: IconNPHAsset,
};

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
