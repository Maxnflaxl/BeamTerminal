import React, { useState } from 'react';
import { styled } from '@linaria/react';
import { scenariosData, fmtAmount, type Metrics, type Unit } from '../compute';
import { useContainerWidth, CHART } from './chartUtils';

const Wrap = styled.div`
  position: relative;
  width: 100%;
`;

const Tip = styled.div`
  position: absolute;
  z-index: 30;
  pointer-events: none;
  transform: translate(-50%, -100%);
  background: #021b35;
  border: 1px solid rgba(0, 246, 210, 0.4);
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 11px;
  line-height: 1.5;
  color: rgba(255, 255, 255, 0.85);
  white-space: nowrap;
  max-width: 220px;
  & b { color: #00f6d2; }
`;

const Note = styled.div`
  margin-top: 8px;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.45);
`;

interface Props {
  metrics: Metrics;
  unit: Unit;
  name1: string;
  name2: string;
  unitName: string;
}

const DESCRIPTIONS: Record<string, string> = {
  Initial: 'Value of the initial position.',
  Current: 'Current position. The lighter slice is fees earned.',
  '1.HODL': 'Current value if the two coins had been kept and NOT deposited.',
};

export const ScenariosChart: React.FC<Props> = ({ metrics, unit, name1, name2, unitName }) => {
  const [ref, width] = useContainerWidth();
  const [tip, setTip] = useState<{ x: number; y: number; html: React.ReactNode } | null>(null);

  const d = scenariosData(metrics, unit, name1, name2);
  const height = CHART.height;
  const padT = 24;
  const padB = 30;
  const padL = 20;
  const padR = 20;
  const chartW = width - padL - padR;
  const chartH = height - padT - padB;

  const maxValue = Math.max(...d.bars.map((b) => b.value));
  const scale = maxValue > 0 ? chartH / maxValue : 0;
  const barWidth = Math.min(48, chartW / (d.bars.length * 1.8));
  const spacing = (chartW - barWidth * d.bars.length) / (d.bars.length - 1);

  const currentY = height - padB - d.current * scale;

  return (
    <Wrap ref={ref}>
      <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} role="img">
        {/* reference line at current worth */}
        <line x1={padL} y1={currentY} x2={width - padR} y2={currentY} stroke={CHART.ref} strokeDasharray="4 3" />
        {d.bars.map((bar, i) => {
          const x = padL + i * (barWidth + spacing);
          const barH = bar.value * scale;
          const y = height - padB - barH;
          const pct = `${((bar.value / d.initial) * 100).toFixed(1)}%`;
          const fill =
            bar.kind === 'initial' ? CHART.initial : bar.kind === 'current' ? CHART.principal : CHART.hypo;

          let onMove: (() => void) | undefined;
          if (bar.kind === 'current') {
            const principalPct = ((d.principal / d.current) * 100).toFixed(1);
            const feesPct = ((d.fees / d.current) * 100).toFixed(1);
            onMove = () =>
              setTip({
                x: x + barWidth / 2,
                y,
                html: (
                  <>
                    <div>Current position</div>
                    <div>Principal: <b>{principalPct}%</b></div>
                    <div>Fees: <b>{feesPct}%</b></div>
                  </>
                ),
              });
          } else {
            const desc = DESCRIPTIONS[bar.label] ?? `Current value if all coins were kept as ${bar.label.replace(/^\d+\.All /, '')}.`;
            onMove = () => setTip({ x: x + barWidth / 2, y, html: <><div>{bar.label}</div><div style={{ opacity: 0.8, whiteSpace: 'normal' }}>{desc}</div></> });
          }

          const feesHeight = bar.kind === 'current' ? d.fees * scale : 0;
          const clipId = `scbar-${i}`;
          return (
            <g key={bar.label} onMouseMove={onMove} onMouseLeave={() => setTip(null)} style={{ cursor: 'pointer' }}>
              {bar.kind === 'current' && (
                <clipPath id={clipId}>
                  <rect x={x} y={y} width={barWidth} height={barH} rx={3} />
                </clipPath>
              )}
              <rect x={x} y={y} width={barWidth} height={barH} rx={3} fill={fill} />
              {bar.kind === 'current' && (
                <rect x={x} y={y} width={barWidth} height={feesHeight} fill={CHART.fees} clipPath={`url(#${clipId})`} />
              )}
              <text x={x + barWidth / 2} y={y - 14} fontSize="10" fontWeight={600} fill={CHART.labelBold} textAnchor="middle">
                {fmtAmount(bar.value)}
              </text>
              <text x={x + barWidth / 2} y={y - 4} fontSize="9" fill={CHART.label} textAnchor="middle">{pct}</text>
              <text x={x + barWidth / 2} y={height - 10} fontSize="10" fill={CHART.label} textAnchor="middle">
                {bar.label}
              </text>
            </g>
          );
        })}
      </svg>
      {tip && <Tip style={{ left: tip.x, top: tip.y - 8 }}>{tip.html}</Tip>}
      <Note>Values in {unitName}</Note>
    </Wrap>
  );
};
