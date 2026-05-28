import React, { useState } from 'react';
import { styled } from '@linaria/react';
import { ilCurveData, fmtAmount, fmtPct, type Metrics, type Unit } from '../compute';
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

const Legend = styled.div`
  display: flex;
  & > * + * { margin-left: 16px; }
  flex-wrap: wrap;
  margin-top: 8px;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.6);
  & span { display: inline-flex; align-items: center; & > * + * { margin-left: 5px; } }
  & i { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
`;

interface Props {
  metrics: Metrics;
  unit: Unit;
  name1: string;
  name2: string;
}

export const ILCurveChart: React.FC<Props> = ({ metrics, unit, name1, name2 }) => {
  const [ref, width] = useContainerWidth();
  const [tip, setTip] = useState<{ x: number; y: number; html: React.ReactNode } | null>(null);

  const d = ilCurveData(metrics, unit);
  const assetOf = unit === 1 ? name2 : name1;
  const inAsset = unit === 1 ? name1 : name2;

  const height = CHART.height;
  const padding = 32;
  const chartW = width - padding * 2;
  const chartH = height - padding * 2;

  const minVal = d.currentIL < -0.5 ? -1.0 : -0.5;
  const maxVal = d.netResult > 0 ? 0.2 : 0.0;
  const range = maxVal - minVal;
  const getY = (val: number): number => {
    const clamped = Math.max(minVal, Math.min(maxVal, val));
    return padding + ((maxVal - clamped) / range) * chartH;
  };
  const getX = (ratio: number): number => padding + (ratio / d.maxRatio) * chartW;

  const points = d.curve.map((c) => `${getX(c.ratio)},${getY(c.il)}`).join(' ');
  const dotX = getX(Math.min(d.maxRatio, d.r));
  const dotY = getY(d.currentIL);
  const netDotY = getY(d.netResult);

  const hGrid = (maxVal > 0 ? [0.2, 0, -0.25, -0.5, -0.75, -1.0] : [0, -0.25, -0.5, -0.75, -1.0]).filter(
    (v) => v >= minVal,
  );

  const showTip = (atY: number, withFees: boolean) => {
    setTip({
      x: dotX,
      y: atY,
      html: withFees ? (
        <>
          <div>Position <b>with</b> fees</div>
          <div>Net vs HODL: <b>{fmtPct(d.netResult)}</b></div>
          <div>Worth: <b>{fmtAmount(d.currentValue)} {unit === 1 ? name1 : name2}</b></div>
        </>
      ) : (
        <>
          <div>Position <b>without</b> fees</div>
          <div>Impermanent loss: <b>{fmtPct(d.currentIL)}</b></div>
          <div>Principal: <b>{fmtAmount(d.principalValue)} {unit === 1 ? name1 : name2}</b></div>
        </>
      ),
    });
  };

  return (
    <Wrap ref={ref}>
      <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} role="img">
        {hGrid.map((v) => {
          const y = getY(v);
          return (
            <g key={`h${v}`}>
              <line x1={padding} y1={y} x2={width - padding} y2={y} stroke={CHART.grid} />
              <text x={padding - 6} y={y + 3} fontSize="10" fill={CHART.label} textAnchor="end">
                {`${v > 0 ? '+' : ''}${v * 100}%`}
              </text>
            </g>
          );
        })}
        {Array.from({ length: d.maxRatio - 1 }, (_, i) => i + 1).map((i) => {
          const x = getX(i);
          return (
            <g key={`v${i}`}>
              <line x1={x} y1={padding} x2={x} y2={height - padding} stroke={CHART.grid} />
              <text x={x} y={padding - 9} fontSize="10" fill={CHART.label} textAnchor="middle">{`x${i}`}</text>
            </g>
          );
        })}
        {/* axes */}
        <line x1={padding} y1={padding} x2={width - padding} y2={padding} stroke={CHART.axis} />
        <line x1={padding} y1={padding} x2={padding} y2={height - padding} stroke={CHART.axis} />
        <text x={padding} y={padding - 9} fontSize="10" fill={CHART.label} textAnchor="middle">x0</text>
        <text x={width - padding} y={padding - 9} fontSize="10" fill={CHART.label} textAnchor="middle">{`x${d.maxRatio}`}</text>
        <text x={padding} y={height - padding + 16} fontSize="10" fontWeight={600} fill={CHART.labelBold} textAnchor="start">IL</text>
        <text x={width - padding} y={padding - 20} fontSize="10" fontWeight={600} fill={CHART.labelBold} textAnchor="end">
          {`Price change of ${assetOf} in ${inAsset}`}
        </text>
        {/* curve */}
        <polyline points={points} fill="none" stroke={CHART.line} strokeWidth={2} />
        {/* connector + dots */}
        <line x1={dotX} y1={dotY} x2={dotX} y2={netDotY} stroke={CHART.fees} strokeWidth={1.5} strokeDasharray="3 3" />
        <circle
          cx={dotX}
          cy={netDotY}
          r={6}
          fill={CHART.fees}
          style={{ cursor: 'pointer' }}
          onMouseMove={() => showTip(netDotY, true)}
          onMouseLeave={() => setTip(null)}
        />
        <circle
          cx={dotX}
          cy={dotY}
          r={4}
          fill={CHART.line}
          style={{ cursor: 'pointer' }}
          onMouseMove={() => showTip(dotY, false)}
          onMouseLeave={() => setTip(null)}
        />
      </svg>
      {tip && (
        <Tip style={{ left: tip.x, top: tip.y - 8 }}>{tip.html}</Tip>
      )}
      <Legend>
        <span><i style={{ background: CHART.line }} /> IL curve</span>
        <span
          onMouseMove={() => showTip(dotY, false)}
          onMouseLeave={() => setTip(null)}
          style={{ cursor: 'help' }}
        >
          <i style={{ background: CHART.line }} /> Position without fees
        </span>
        <span
          onMouseMove={() => showTip(netDotY, true)}
          onMouseLeave={() => setTip(null)}
          style={{ cursor: 'help' }}
        >
          <i style={{ background: CHART.fees }} /> Position with fees
        </span>
      </Legend>
    </Wrap>
  );
};
