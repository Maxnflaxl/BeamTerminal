import React, { useState } from 'react';
import { styled } from '@linaria/react';
import { simulatorData, fmtAmount, fmtPct, type Metrics, type Unit } from '../compute';
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
  & b { color: #00f6d2; }
`;

const Controls = styled.div`
  display: flex;
  & > * + * { margin-left: 24px; }
  flex-wrap: wrap;
  margin-top: 12px;
`;

const Control = styled.label`
  flex: 1;
  min-width: 200px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.7);
  display: flex;
  flex-direction: column;
  & > * + * { margin-top: 6px; }
  & b { color: #00f6d2; }
  & input[type='range'] { width: 100%; accent-color: #00f6d2; }
`;

const Info = styled.div`
  margin-top: 10px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.6);
  & b { color: #00f6d2; }
`;

interface Props {
  metrics: Metrics;
  unit: Unit;
  name1: string;
  name2: string;
  unitName: string;
}

export const SimulatorChart: React.FC<Props> = ({ metrics, unit, name1, name2, unitName }) => {
  const [ref, width] = useContainerWidth();
  const [durationMonths, setDurationMonths] = useState(12);
  const [usageStep, setUsageStep] = useState(1);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const usageMultiplier = usageStep === 0 ? 0.5 : usageStep;
  const d = simulatorData(metrics, unit, durationMonths, usageMultiplier);

  const height = CHART.height;
  const padT = 20;
  const padB = 40;
  const padL = 40;
  const padR = 20;
  const chartW = width - padL - padR;
  const chartH = height - padT - padB;

  const allY = [...d.pointsFuture.map((p) => p.y), ...d.pointsPrincipal.map((p) => p.y), 0];
  const minY = Math.min(...allY) - 0.05;
  const maxY = Math.max(...allY) + 0.05;
  const getY = (y: number): number => height - padB - ((y - minY) / (maxY - minY)) * chartH;
  const getX = (i: number): number => padL + (i / (d.ratios.length - 1)) * chartW;

  // Horizontal grid step.
  const rawRange = maxY - minY;
  let step = 0.1;
  if (rawRange < 0.25) step = 0.05;
  if (rawRange > 0.6) step = 0.25;
  if (rawRange > 1.2) step = 0.5;
  const gridValues = [0];
  for (let v = step; v <= maxY; v += step) gridValues.push(v);
  for (let v = -step; v >= minY; v -= step) gridValues.push(v);

  const linePath = (pts: Array<{ y: number }>): string =>
    pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${getX(i)} ${getY(p.y)}`).join(' ');

  const principalPath = linePath(d.pointsPrincipal);
  const futurePath = linePath(d.pointsFuture);
  const baseY = height - padB;
  const fillPrincipal = `${principalPath} L ${getX(d.pointsPrincipal.length - 1)} ${baseY} L ${getX(0)} ${baseY} Z`;
  const fillFees = `${futurePath} ${d.pointsPrincipal
    .map((_p, i) => {
      const j = d.pointsPrincipal.length - 1 - i;
      return `L ${getX(j)} ${getY(d.pointsPrincipal[j]!.y)}`;
    })
    .join(' ')} Z`;

  const yZero = getY(0);
  const yInitial = getY(d.yInitial);

  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    const rect = (e.currentTarget.ownerSVGElement ?? e.currentTarget).getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * width;
    const frac = Math.max(0, Math.min(1, (px - padL) / chartW));
    setHoverIdx(Math.round(frac * (d.ratios.length - 1)));
  };

  const hovered = hoverIdx !== null ? d.pointsFuture[hoverIdx] : null;

  return (
    <Wrap ref={ref}>
      <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} role="img">
        {gridValues.map((val) => {
          const y = getY(val);
          return (
            <g key={`g${val.toFixed(3)}`}>
              <line x1={padL} y1={y} x2={width - padR} y2={y} stroke={CHART.grid} />
              <text x={padL - 5} y={y + 3} fontSize="10" fill={CHART.label} textAnchor="end">
                {`${val > 0 ? '+' : ''}${(val * 100).toFixed(0)}%`}
              </text>
            </g>
          );
        })}
        {d.ratios.map((r, i) => {
          const x = getX(i);
          return (
            <g key={`r${r}`}>
              <line x1={x} y1={padT} x2={x} y2={height - padB} stroke={r === 1 ? CHART.gridBold : CHART.grid} />
              <text x={x} y={height - padB + 15} fontSize="10" fill={CHART.label} textAnchor="middle">{d.labels[i]}</text>
            </g>
          );
        })}
        <text x={padL + 5} y={padT - 8} fontSize="10" fontWeight={600} fill={CHART.labelBold} textAnchor="start">
          {`Next profit in ${unitName}`}
        </text>
        <text x={width - padR} y={height - 4} fontSize="10" fontWeight={600} fill={CHART.labelBold} textAnchor="end">
          {`Price change of ${unit === 1 ? name2 : name1} in ${unitName}`}
        </text>

        <path d={fillPrincipal} fill={CHART.areaPrincipal} stroke="none" />
        <path d={fillFees} fill={CHART.areaFees} stroke="none" />

        <line x1={padL} y1={yInitial} x2={width - padR} y2={yInitial} stroke={CHART.initial} strokeDasharray="5 3" />
        <line x1={padL} y1={yZero} x2={width - padR} y2={yZero} stroke={CHART.current} strokeDasharray="2 2" />
        <path d={futurePath} fill="none" stroke={CHART.line} strokeWidth={2} />

        <rect
          x={padL}
          y={padT}
          width={chartW}
          height={chartH}
          fill="transparent"
          onMouseMove={onMove}
          onMouseLeave={() => setHoverIdx(null)}
        />
        {hovered && hoverIdx !== null && (
          <circle cx={getX(hoverIdx)} cy={getY(hovered.y)} r={5} fill={CHART.line} />
        )}
      </svg>
      {hovered && hoverIdx !== null && (
        <Tip style={{ left: getX(hoverIdx), top: getY(hovered.y) - 8 }}>
          <div>Price {d.labels[hoverIdx]}</div>
          <div>Next profit: <b>{fmtPct(hovered.y)}</b></div>
          <div>Principal: <b>{fmtAmount(hovered.principal)} {unitName}</b></div>
          <div>+ Fees: <b>{fmtAmount(hovered.fees)} {unitName}</b></div>
        </Tip>
      )}

      <Controls>
        <Control>
          <span>Next duration: <b>{durationMonths} months</b></span>
          <input
            type="range"
            min={0}
            max={24}
            step={1}
            value={durationMonths}
            onChange={(e) => setDurationMonths(Number(e.target.value))}
          />
        </Control>
        <Control>
          <span>Change in fees: <b>x{usageMultiplier.toFixed(1)}</b></span>
          <input
            type="range"
            min={0}
            max={10}
            step={1}
            value={usageStep}
            onChange={(e) => setUsageStep(Number(e.target.value))}
          />
        </Control>
      </Controls>
      <Info>
        {d.breakevenDays !== null ? (
          <>At the current price and average fees, you offset the IL in <b>{d.breakevenDays} days</b>.</>
        ) : (
          <>Your position is currently profitable compared to the initial deposit.</>
        )}
      </Info>
    </Wrap>
  );
};
