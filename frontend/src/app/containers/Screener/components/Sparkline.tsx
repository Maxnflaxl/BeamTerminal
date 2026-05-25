import React from 'react';

interface Props {
  values: ReadonlyArray<number>;
  width?: number;
  height?: number;
}

/**
 * Pure-SVG sparkline. No tooltip / no axes — meant for table-row previews
 * where lightweight-charts is overkill (would spawn one canvas per row).
 * Trend color: green if last >= first, red otherwise. Dim grey if no data.
 */
export const Sparkline: React.FC<Props> = ({ values, width = 96, height = 28 }) => {
  if (!values || values.length < 2) {
    return (
      <svg width={width} height={height} role="img" aria-label="no data">
        <line
          x1={0}
          x2={width}
          y1={height / 2}
          y2={height / 2}
          stroke="rgba(255,255,255,0.12)"
          strokeWidth={1}
          strokeDasharray="2 3"
        />
      </svg>
    );
  }

  let lo = values[0]!;
  let hi = values[0]!;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  // Vertical padding so a flat series doesn't render at the top/bottom edge.
  const pad = 2;
  const range = hi - lo || 1;
  const step = values.length === 1 ? 0 : width / (values.length - 1);
  const y = (v: number): number => height - pad - ((v - lo) / range) * (height - pad * 2);

  const d = values
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(2)},${y(v).toFixed(2)}`)
    .join(' ');

  const positive = values[values.length - 1]! >= values[0]!;
  const stroke = positive ? '#00e2c2' : '#ff5f5f';

  return (
    <svg width={width} height={height} role="img" aria-label="7-day price">
      <path d={d} fill="none" stroke={stroke} strokeWidth={1.25} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
};
