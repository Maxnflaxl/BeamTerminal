import React, { useState } from 'react';
import { theme } from './theme';

// Reusable SVG donut/ring chart with a built-in hover layer: pointing at a
// slice (or driving `activeKey` from an external legend) dims the others and
// swaps the centre hole to that slice's label + detail. Used by the DAO
// treasury holdings donut and the Mining block-attribution donut; any future
// part-to-whole breakdown should reuse this rather than re-rolling the SVG.

export interface DonutSlice {
  /** Stable identity for the slice (also what `onSliceClick`/`activeKey` use). */
  key: string;
  label: string;
  color: string;
  /** Magnitude — drives both the arc length and the default hover %. */
  value: number;
  /** Optional pre-formatted secondary line for the hole on hover. Defaults to
   *  `${value} · ${pct}%` (used e.g. to show a USD value instead). */
  detail?: string;
}

function fmtPct(v: number, total: number): string {
  return `${((v / total) * 100).toFixed(1)}%`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

interface DonutProps {
  slices: DonutSlice[];
  size?: number;
  /** Circumferential gap between slices in px. 0 → seam-lapped (no gap). */
  gap?: number;
  /** Ring thickness in px (default size * 0.16). */
  thickness?: number;
  /** Centre content when nothing is hovered. */
  idlePrimary?: React.ReactNode;
  idleSecondary?: React.ReactNode;
  /** Controlled highlight — when provided (incl. null), this key is the
   *  highlighted slice, so an external legend can drive it. Omit entirely for
   *  internal-only hover. */
  activeKey?: string | null;
  onActiveChange?: (key: string | null) => void;
  onSliceClick?: (key: string) => void;
}

export const Donut: React.FC<DonutProps> = ({
  slices,
  size = 180,
  gap = 0,
  thickness,
  idlePrimary,
  idleSecondary,
  activeKey,
  onActiveChange,
  onSliceClick,
}) => {
  const [internal, setInternal] = useState<string | null>(null);
  const controlled = activeKey !== undefined;
  const active = controlled ? activeKey ?? null : internal;
  const setActive = (k: string | null): void => {
    if (!controlled) setInternal(k);
    onActiveChange?.(k);
  };

  const total = slices.reduce((a, s) => a + s.value, 0) || 1;
  const r = size / 2;
  const stroke = thickness ?? size * 0.16;
  const radius = r - stroke / 2 - 1; // -1 keeps the ring's outer edge off the viewBox seam
  const circ = 2 * Math.PI * radius;
  const activeSlice = active != null ? slices.find((s) => s.key === active) ?? null : null;

  let offset = 0;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      style={{ display: 'block' }}
      onMouseLeave={() => setActive(null)}
    >
      <g transform={`rotate(-90 ${r} ${r})`}>
        {slices.length === 0 && (
          <circle cx={r} cy={r} r={radius} fill="none" stroke={theme.color.surface2} strokeWidth={stroke} />
        )}
        {slices.map((s) => {
          const frac = s.value / total;
          const full = frac * circ;
          // gap>0 leaves a clean gap after each slice; gap===0 overlaps the seam
          // by a hair so float drift can't leave an anti-aliased dark notch.
          const lap = gap > 0 ? 0 : full > 0 ? 0.75 : 0;
          const dash = gap > 0 ? Math.max(0, full - gap) : full + lap;
          const el = (
            <circle
              key={s.key}
              cx={r}
              cy={r}
              r={radius}
              fill="none"
              stroke={s.color}
              strokeWidth={stroke}
              strokeDasharray={`${dash.toFixed(2)} ${Math.max(0, circ - dash).toFixed(2)}`}
              strokeDashoffset={(-offset).toFixed(2)}
              opacity={active == null || active === s.key ? 1 : 0.35}
              style={{ cursor: onSliceClick ? 'pointer' : 'default', transition: 'opacity .12s' }}
              onMouseEnter={() => setActive(s.key)}
              onClick={onSliceClick ? () => onSliceClick(s.key) : undefined}
            />
          );
          offset += full;
          return el;
        })}
      </g>
      {activeSlice ? (
        <>
          <text
            x={r}
            y={r - 3}
            textAnchor="middle"
            fontSize={Math.round(size * 0.085)}
            fontWeight={700}
            fill={theme.color.text}
            style={{ pointerEvents: 'none' }}
          >
            {truncate(activeSlice.label, 15)}
          </text>
          <text
            x={r}
            y={r + 14}
            textAnchor="middle"
            fontSize={10}
            fill={theme.color.muted}
            style={{ pointerEvents: 'none' }}
          >
            {activeSlice.detail ?? `${activeSlice.value} · ${fmtPct(activeSlice.value, total)}`}
          </text>
        </>
      ) : (
        <>
          {idlePrimary != null && (
            <text
              x={r}
              y={idleSecondary != null ? r - 1 : r + 5}
              textAnchor="middle"
              fontSize={Math.round(size * 0.12)}
              fontWeight={700}
              fill={theme.color.text}
              style={{ pointerEvents: 'none' }}
            >
              {idlePrimary}
            </text>
          )}
          {idleSecondary != null && (
            <text
              x={r}
              y={r + 15}
              textAnchor="middle"
              fontSize={9}
              letterSpacing="1.2"
              fill={theme.color.muted}
              style={{ pointerEvents: 'none' }}
            >
              {idleSecondary}
            </text>
          )}
        </>
      )}
    </svg>
  );
};

export default Donut;
