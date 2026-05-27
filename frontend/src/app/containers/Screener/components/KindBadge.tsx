import React from 'react';
import { styled } from '@linaria/react';

const colorByKind: Record<number, string> = {
  0: '#0bccf7', // Low — blue
  1: '#00f6d2', // Medium — green
  2: '#f4ce4a', // High — yellow
};

// AMM fee tiers (see Amm::FeeSettings in beam/bvm/Shaders/amm/contract.h)
const labelByKind: Record<number, string> = {
  0: '0.05%',
  1: '0.3%',
  2: '1%',
};

const Pill = styled.span<{ color: string }>`
  display: inline-flex;
  align-items: center;
  height: 16px;
  padding: 0 6px;
  border-radius: 8px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.4px;
  text-transform: uppercase;
  background: ${(p) => p.color}22;
  color: ${(p) => p.color};
`;

export const KindBadge: React.FC<{ kind: number }> = ({ kind }) => (
  <Pill color={colorByKind[kind] ?? '#8196a4'}>{labelByKind[kind] ?? '?'}</Pill>
);

const Dots = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 3px;
`;

const Dot = styled.span<{ color: string }>`
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: ${(p) => p.color};
`;

/** Compact indicator of which fee tiers a combined pair offers. One tier renders
 *  as a normal fee pill; several render as colour-coded dots (Low→High) with a
 *  tooltip listing the fees. */
export const TiersBadge: React.FC<{ kinds: number[] }> = ({ kinds }) => {
  const sorted = [...kinds].sort((a, b) => a - b);
  if (sorted.length <= 1) return <KindBadge kind={sorted[0] ?? 0} />;
  const title = sorted.map((k) => labelByKind[k] ?? '?').join(' · ');
  return (
    <Dots title={title}>
      {sorted.map((k) => (
        <Dot key={k} color={colorByKind[k] ?? '#8196a4'} />
      ))}
    </Dots>
  );
};
