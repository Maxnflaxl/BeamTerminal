import React from 'react';
import { styled } from '@linaria/react';

// App-wide asset label convention: `SYMBOL (#aid)` with the id in a dim small.
// Assets without a known symbol render as `Asset #aid`.

export const assetSymbol = (aid: number, sym?: string | null): string => sym || `Asset #${aid}`;

export const assetLabel = (aid: number, sym?: string | null): string => (sym ? `${sym} (#${aid})` : `Asset #${aid}`);

export const AssetAid = styled.small`
  margin-left: 4px;
  font-size: 11px;
  font-weight: 400;
  color: rgba(255, 255, 255, 0.4);
`;

export function AssetLabel({
  aid,
  sym,
  className,
}: {
  aid: number;
  sym?: string | null;
  className?: string;
}): JSX.Element {
  if (!sym) return <span className={className}>Asset #{aid}</span>;
  return (
    <span className={className}>
      {sym}
      <AssetAid>(#{aid})</AssetAid>
    </span>
  );
}
