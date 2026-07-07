import React from 'react';
import { styled } from '@linaria/react';
import { theme } from '../shared';

// Shared bits for the DAO pages: BEAMX/USD formatters, a stacked tally bar, and
// a dependency-free SVG sparkline (keeps these pages off lightweight-charts).

export function grothToBeamx(groth: string | number | null | undefined): number {
  return groth == null ? 0 : Number(groth) / 1e8;
}

export function fmtCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B';
  if (abs >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
  if (abs >= 1e3) return (n / 1e3).toFixed(1).replace(/\.?0+$/, '') + 'K';
  return n.toFixed(abs > 0 && abs < 1 ? 2 : 0);
}

export function fmtBeamx(groth: string | number | null | undefined): string {
  return `${fmtCompact(grothToBeamx(groth))} BEAMX`;
}

export function fmtUsd(n: number | null | undefined): string {
  return n == null ? '—' : `$${fmtCompact(n)}`;
}

export function variantColor(variant: number): string {
  if (variant === 1) return theme.color.accent; // Yes
  if (variant === 0) return theme.color.danger; // No
  return theme.color.purple;
}

const BarRoot = styled.div`
  display: flex;
  height: 10px;
  border-radius: 4px;
  overflow: hidden;
  background: ${theme.color.surface2};
  margin: 8px 0 6px;
`;

export const TallyBar: React.FC<{ tallies: ReadonlyArray<{ variant: number; pct: number }> }> = ({ tallies }) => (
  <BarRoot>
    {tallies.map((t) => (
      <div key={t.variant} style={{ width: `${t.pct}%`, height: '100%', background: variantColor(t.variant) }} />
    ))}
  </BarRoot>
);

export const Sparkline: React.FC<{ data: ReadonlyArray<number>; height?: number; color?: string }> = ({
  data,
  height = 48,
  color = theme.color.accent,
}) => {
  if (data.length < 2) return null;
  const w = 600;
  const h = height;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const pts = data.map((v, i) => [(i / (data.length - 1)) * w, h - ((v - min) / range) * (h - 4) - 2] as const);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${w},${h} L0,${h} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: '100%', height: h, display: 'block' }}>
      <path d={area} fill={color} opacity={0.15} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.5} />
    </svg>
  );
};

export type PillTone = 'accent' | 'danger' | 'warn' | 'neutral';

export function outcomeTone(status: string, outcome: string | null): PillTone {
  if (status === 'live') return 'warn';
  if (outcome === 'passed') return 'accent';
  if (outcome === 'failed') return 'danger';
  return 'neutral';
}

export function outcomeLabel(status: string, outcome: string | null): string {
  if (status === 'live') return 'Live';
  if (outcome === 'passed') return 'Passed';
  if (outcome === 'failed') return 'Failed';
  return 'Closed';
}
