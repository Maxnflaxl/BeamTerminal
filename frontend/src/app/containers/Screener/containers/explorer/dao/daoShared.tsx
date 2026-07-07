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

// Area chart with labelled X (date) and Y (value) axes + gridlines. viewBox
// scales to the container width; height is auto so text stays proportional.
export const TimeChart: React.FC<{
  data: ReadonlyArray<{ label: string; value: number }>;
  height?: number;
  color?: string;
  fmtY?: (n: number) => string;
}> = ({ data, height = 170, color = theme.color.accent, fmtY }) => {
  const fy = fmtY ?? ((n: number) => fmtCompact(n));
  if (data.length < 2) {
    return (
      <div style={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.color.muted, fontSize: 12 }}>
        Not enough data yet
      </div>
    );
  }
  const w = 820;
  const h = height;
  const padL = 56;
  const padB = 22;
  const padT = 10;
  const padR = 12;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const values = data.map((d) => d.value);
  const max = Math.max(...values);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const xAt = (i: number): number => padL + (i / (data.length - 1)) * plotW;
  const yAt = (v: number): number => padT + plotH - ((v - min) / range) * plotH;
  const line = data.map((d, i) => `${i ? 'L' : 'M'}${xAt(i).toFixed(1)},${yAt(d.value).toFixed(1)}`).join(' ');
  const area = `${line} L${xAt(data.length - 1).toFixed(1)},${(padT + plotH).toFixed(1)} L${padL},${(padT + plotH).toFixed(1)} Z`;
  const yTicks = [min, min + range / 2, max];
  const xIdx = [0, Math.floor((data.length - 1) / 2), data.length - 1];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" style={{ display: 'block', height: 'auto' }}>
      {yTicks.map((v, i) => (
        <g key={`y${i}`}>
          <line x1={padL} y1={yAt(v)} x2={w - padR} y2={yAt(v)} stroke={theme.color.borderDim} strokeWidth={0.5} />
          <text x={padL - 7} y={yAt(v) + 3} textAnchor="end" fontSize={10} fill={theme.color.muted}>
            {fy(v)}
          </text>
        </g>
      ))}
      {xIdx.map((idx, i) => (
        <text
          key={`x${i}`}
          x={xAt(idx)}
          y={h - 6}
          textAnchor={i === 0 ? 'start' : i === xIdx.length - 1 ? 'end' : 'middle'}
          fontSize={10}
          fill={theme.color.muted}
        >
          {data[idx].label.slice(0, 7)}
        </text>
      ))}
      <path d={area} fill={color} opacity={0.14} />
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
