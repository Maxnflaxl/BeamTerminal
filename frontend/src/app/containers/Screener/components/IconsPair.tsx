import React from 'react';
import { styled } from '@linaria/react';
import AssetIcon from '@app/shared/components/AssetsIcon';

// Two AssetIcons side-by-side. The `size` prop is intentionally ignored —
// AssetIcon uses its SVG's intrinsic 18×18 layout (stroke + radial gradient)
// which doesn't scale cleanly. Standardising on 18px everywhere matches how
// the trade panel renders, which is the visual target.

const Wrap = styled.span`
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  vertical-align: middle;
  gap: 2px;

  /* Strip the default right-margin from AssetIcon — it's set for the trade
     panel's text-adjacent layout and creates dead space between the pair's
     two icons. */
  & > * { margin-right: 0 !important; }
`;

interface Props {
  aid1: number;
  aid2: number;
  /** Accepted for backwards compatibility; ignored — see file header. */
  size?: number;
}

export const IconsPair: React.FC<Props> = ({ aid1, aid2 }) => (
  <Wrap>
    <AssetIcon asset_id={aid1} />
    <AssetIcon asset_id={aid2} />
  </Wrap>
);
