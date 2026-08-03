// Mining profitability calculator — ported from 0xmx.net/mining/script.js?v=2
// Renders inside the Mining.tsx modal. No chart.js, no new npm deps.
// Chrome-83 / QtWebEngine 5.15.2 safe.

import React, { useEffect, useMemo, useState } from 'react';
import { styled } from '@linaria/react';
import { fmtGrouped } from '../../components/format';
import { api } from '../../api/client';
import { ApiMiningPool } from '../../api/types';
import { blockRewardAtHeight } from './supplyMath';
import {
  StatGrid,
  StatCard,
  Label,
  Value,
  SubValue,
  Input,
  Select,
  TabBtn,
  theme,
  fmtHashrate as fmtHashrateShared,
} from './shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeNum(v: string): number {
  const n = parseFloat(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return `$${fmtGrouped(n, 2)}`;
}

function fmtUsdLong(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return `$${n.toFixed(4)}`;
}

function fmtHashrate(solPerSec: number): string {
  // Local zero-handling on top of the shared formatter: sliders start at 0.
  return Number.isFinite(solPerSec) && solPerSec > 0 ? fmtHashrateShared(solPerSec) : '—';
}

function fmtDuration(secs: number): string {
  if (!Number.isFinite(secs) || secs <= 0) return '—';
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 || parts.length === 0) parts.push(`${s}s`);
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Profit formula (ported from 0xmx.net, extended with a pool fee)
// ---------------------------------------------------------------------------

interface CalcInputs {
  netHash: number; // Sol/s
  reward: number; // BEAM per block
  price: number; // USD per BEAM
  blockMin: number; // minutes per block
  yourHash: number; // Sol/s
  watts: number; // power consumption W
  kwh: number; // electricity cost USD/kWh
  feePct: number; // pool fee, % of revenue (0 in solo mode)
}

interface CalcResult {
  blocksPerDay: number;
  networkCoinsPerDay: number;
  yourShare: number;
  grossCoinsPerDay: number;
  yourCoinsPerDay: number; // net of the pool fee — what actually gets paid out
  yourValuePerDay: number;
  dailyPowerCost: number;
  dailyProfit: number;
  margin: number;
  timeToBlockSecs: number;
  bePriceUsd: number;
  beKwh: number;
  beNetHash: number;
}

function calc(inputs: CalcInputs): CalcResult {
  const { netHash, reward, price, blockMin, yourHash, watts, kwh, feePct } = inputs;
  const blockMinSafe = Math.max(blockMin, 1e-9);
  const feeFrac = Math.min(Math.max(feePct, 0), 100) / 100;
  const keep = 1 - feeFrac;
  const blocksPerDay = 1440 / blockMinSafe;
  const networkCoinsPerDay = blocksPerDay * reward;
  const yourShare = yourHash > 0 && netHash > 0 ? yourHash / netHash : 0;
  const grossCoinsPerDay = networkCoinsPerDay * yourShare;
  const yourCoinsPerDay = grossCoinsPerDay * keep;
  const yourValuePerDay = yourCoinsPerDay * price;
  const dailyPowerCost = (watts / 1000) * kwh * 24;
  const dailyProfit = yourValuePerDay - dailyPowerCost;
  const margin = yourValuePerDay > 0 ? (100 * dailyProfit) / yourValuePerDay : 0;
  const timeToBlockSecs = yourHash > 0 && netHash > 0 ? (netHash / yourHash) * blockMin * 60 : Infinity;
  const bePriceUsd = yourCoinsPerDay > 0 ? dailyPowerCost / yourCoinsPerDay : 0;
  const beKwh = watts > 0 ? yourValuePerDay / ((watts / 1000) * 24) : 0;
  const beNetHash =
    price > 0 && dailyPowerCost > 0 ? (yourHash * networkCoinsPerDay * keep * price) / dailyPowerCost : 0;
  return {
    blocksPerDay,
    networkCoinsPerDay,
    yourShare,
    grossCoinsPerDay,
    yourCoinsPerDay,
    yourValuePerDay,
    dailyPowerCost,
    dailyProfit,
    margin,
    timeToBlockSecs,
    bePriceUsd,
    beKwh,
    beNetHash,
  };
}

// ---------------------------------------------------------------------------
// Profit vs network hashrate SVG chart
// ---------------------------------------------------------------------------

interface ChartProps {
  inputs: CalcInputs;
  effectiveNetHash: number;
}

const SVG_W = 560;
const SVG_H = 240;
const PAD = {
  top: 22,
  right: 46,
  bottom: 44,
  left: 62,
};

// Matches 0xmx.net/mining CHART_MIN_FRACTION / CHART_MAX_FRACTION / CHART_SAMPLES.
const X_MIN_FRACTION = 0.1;
const X_MAX_FRACTION = 3.0;
const SAMPLES = 101;

const C_LINE = theme.color.accent;
const C_ZERO = theme.color.danger;
const C_CURRENT = theme.color.warn;
const C_GRID = 'rgba(255,255,255,0.07)';
const C_AXIS = 'rgba(255,255,255,0.5)';

const NICE_MULTS = [1, 2, 2.5, 5, 10];

/** Snap `range / target` to the closest 1/2/2.5/5/10 × 10ⁿ so ticks land on readable values. */
function niceStep(range: number, target: number): number {
  if (!(range > 0) || !Number.isFinite(range)) return 1;
  const raw = range / Math.max(target, 1);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const mult = NICE_MULTS.reduce((best, m) => (Math.abs(m - norm) < Math.abs(best - norm) ? m : best), NICE_MULTS[0]);
  return mult * mag;
}

function ticksFor(min: number, max: number, target: number): number[] {
  const step = niceStep(max - min, target);
  const out: number[] = [];
  const start = Math.ceil(min / step - 1e-9) * step;
  for (let v = start; v <= max + step * 1e-6; v += step) {
    out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
    if (out.length > 24) break;
  }
  return out;
}

function fmtAxisY(v: number): string {
  const a = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (a >= 1000) return `${sign}$${fmtGrouped(a, 0)}`;
  if (a === 0) return '$0';
  if (a < 0.01) return `${sign}$${a.toFixed(4)}`;
  if (a < 1) return `${sign}$${a.toFixed(2)}`;
  return `${sign}$${a.toFixed(a < 10 ? 2 : 0)}`;
}

function fmtAxisX(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}G`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(0);
}

const ProfitChart: React.FC<ChartProps> = ({ inputs, effectiveNetHash }) => {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const { reward, price, blockMin, yourHash, watts, kwh, feePct } = inputs;

  const pts = useMemo(() => {
    if (effectiveNetHash <= 0 || yourHash <= 0 || reward <= 0) return [];
    const lo = effectiveNetHash * X_MIN_FRACTION;
    const hi = effectiveNetHash * X_MAX_FRACTION;
    const out: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < SAMPLES; i++) {
      const nh = lo + ((hi - lo) * i) / (SAMPLES - 1);
      const r = calc({ netHash: nh, reward, price, blockMin, yourHash, watts, kwh, feePct });
      out.push({ x: nh, y: r.dailyProfit });
    }
    return out;
  }, [effectiveNetHash, reward, price, blockMin, yourHash, watts, kwh, feePct]);

  if (pts.length === 0) return null;

  const xMin = pts[0].x;
  const xMax = pts[pts.length - 1].x;

  // Y domain always spans 0 so the break-even line is on-scale, then snapped out
  // to the tick step so the top/bottom gridlines are labelled values.
  const yValues = pts.map((p) => p.y);
  const yLo = Math.min(0, ...yValues);
  const yHi = Math.max(0, ...yValues);
  // Epsilon nudges are inward, so a bound already sitting on a step boundary
  // (the common yLo === 0 case) does not gain an empty extra step.
  const yStep = niceStep(yHi - yLo || 1, 4);
  const yMin = Math.floor(yLo / yStep + 1e-9) * yStep;
  const yMaxRaw = Math.ceil(yHi / yStep - 1e-9) * yStep;
  const yMax = yMaxRaw > yMin ? yMaxRaw : yMin + yStep;
  const yRange = yMax - yMin;

  const plotW = SVG_W - PAD.left - PAD.right;
  const plotH = SVG_H - PAD.top - PAD.bottom;

  const toSvgX = (nh: number) => PAD.left + ((nh - xMin) / (xMax - xMin)) * plotW;
  const toSvgY = (profit: number) => PAD.top + (1 - (profit - yMin) / yRange) * plotH;

  const pathD = pts
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${toSvgX(p.x).toFixed(1)} ${toSvgY(p.y).toFixed(1)}`)
    .join(' ');

  const y0 = toSvgY(0);
  const xNetHash = toSvgX(effectiveNetHash);

  const yTicks = ticksFor(yMin, yMax, 4);
  const xTicks = ticksFor(xMin, xMax, 5);

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const svgX = ((e.clientX - rect.left) * SVG_W) / rect.width;
    const t = (svgX - PAD.left) / plotW;
    if (t < -0.02 || t > 1.02) {
      setHoverIdx(null);
      return;
    }
    setHoverIdx(Math.min(SAMPLES - 1, Math.max(0, Math.round(t * (SAMPLES - 1)))));
  }

  const hp = hoverIdx != null ? pts[hoverIdx] : null;
  const hx = hp ? toSvgX(hp.x) : 0;
  const hy = hp ? toSvgY(hp.y) : 0;
  // Readout box: fixed-width estimate (mono face, 9px) instead of measuring text.
  const boxLines = hp ? [`Network: ${fmtAxisX(hp.x)} Sol/s`, `Profit: ${fmtAxisY(hp.y)}`] : [];
  const boxW = Math.max(...boxLines.map((s) => s.length), 0) * 5.4 + 12;
  const boxH = 30;
  const boxX = hx + 10 + boxW > PAD.left + plotW ? hx - 10 - boxW : hx + 10;
  const boxY = Math.min(Math.max(hy - boxH / 2, PAD.top + 2), PAD.top + plotH - boxH - 2);

  return (
    <svg
      viewBox={`0 0 ${SVG_W} ${SVG_H}`}
      style={{ width: '100%', height: 'auto', display: 'block', touchAction: 'none' }}
      onPointerMove={onMove}
      onPointerLeave={() => setHoverIdx(null)}
    >
      {/* Horizontal gridlines + Y ticks */}
      {yTicks.map((v, i) => {
        const sy = toSvgY(v);
        return (
          <g key={`y${i}`}>
            <line x1={PAD.left} y1={sy} x2={PAD.left + plotW} y2={sy} stroke={C_GRID} strokeWidth="1" />
            <text x={PAD.left - 7} y={sy + 3} textAnchor="end" fontSize="9" fill={C_AXIS}>
              {fmtAxisY(v)}
            </text>
          </g>
        );
      })}
      {/* Vertical gridlines + X ticks */}
      {xTicks.map((v, i) => {
        const sx = toSvgX(v);
        return (
          <g key={`x${i}`}>
            <line x1={sx} y1={PAD.top} x2={sx} y2={PAD.top + plotH} stroke={C_GRID} strokeWidth="1" />
            <text x={sx} y={PAD.top + plotH + 13} textAnchor="middle" fontSize="9" fill={C_AXIS}>
              {fmtAxisX(v)}
            </text>
          </g>
        );
      })}
      {/* Axis labels */}
      <text x={PAD.left + plotW / 2} y={SVG_H - 4} textAnchor="middle" fontSize="9" fill={theme.color.muted2}>
        Network hashrate (Sol/s)
      </text>
      <text
        x={10}
        y={PAD.top + plotH / 2}
        textAnchor="middle"
        fontSize="9"
        fill={theme.color.muted2}
        transform={`rotate(-90,${10},${PAD.top + plotH / 2})`}
      >
        Profit/day (USD)
      </text>
      {/* Plot border */}
      <rect
        x={PAD.left}
        y={PAD.top}
        width={plotW}
        height={plotH}
        fill="none"
        stroke={theme.color.divider}
        strokeWidth="1"
      />
      {/* Break-even ($0) line — always in range */}
      <line
        x1={PAD.left}
        y1={y0}
        x2={PAD.left + plotW}
        y2={y0}
        stroke={C_ZERO}
        strokeWidth="1.25"
        strokeDasharray="4 4"
      />
      {/* Current network hashrate marker */}
      <line
        x1={xNetHash}
        y1={PAD.top}
        x2={xNetHash}
        y2={PAD.top + plotH}
        stroke={C_CURRENT}
        strokeWidth="1.25"
        strokeDasharray="5 5"
      />
      <text x={xNetHash} y={PAD.top + 10} textAnchor="middle" fontSize="9" fill={C_CURRENT}>
        current
      </text>
      {/* Curve */}
      <path d={pathD} fill="none" stroke={C_LINE} strokeWidth="2" strokeLinejoin="round" />
      {/* Hover crosshair + readout */}
      {hp && (
        <g pointerEvents="none">
          <line x1={hx} y1={PAD.top} x2={hx} y2={PAD.top + plotH} stroke={C_AXIS} strokeWidth="1" />
          <circle cx={hx} cy={hy} r="3" fill={C_LINE} />
          <rect
            x={boxX}
            y={boxY}
            width={boxW}
            height={boxH}
            rx="4"
            fill={theme.color.bg}
            stroke={theme.color.border}
            strokeWidth="1"
          />
          <text x={boxX + 6} y={boxY + 13} fontSize="9" fill={theme.color.muted}>
            {boxLines[0]}
          </text>
          <text x={boxX + 6} y={boxY + 24} fontSize="9" fill={hp.y >= 0 ? C_LINE : C_ZERO}>
            {boxLines[1]}
          </text>
        </g>
      )}
    </svg>
  );
};

// ---------------------------------------------------------------------------
// Styled sub-components
// ---------------------------------------------------------------------------

const FormGrid = styled.div`
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-gap: 12px;
  margin-bottom: 16px;
  @media (max-width: 600px) {
    grid-template-columns: 1fr;
  }
`;

const FieldWrap = styled.div`
  display: -webkit-box;
  display: flex;
  -webkit-box-orient: vertical;
  -webkit-box-direction: normal;
  flex-direction: column;
`;

const FieldLabel = styled.label`
  font-size: 10px;
  color: ${theme.color.muted};
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 4px;
`;

const FieldHint = styled.span`
  font-size: 10px;
  color: ${theme.color.muted};
  margin-top: 2px;
`;

const SectionTitle = styled.div`
  font-size: 10px;
  color: ${theme.color.muted};
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin-bottom: 8px;
  margin-top: 16px;
  padding-bottom: 4px;
  border-bottom: 1px solid ${theme.color.divider};
`;

const ModeRow = styled.div`
  display: -webkit-box;
  display: flex;
  -webkit-box-align: center;
  align-items: center;
  margin-bottom: 12px;
  & > button {
    margin-right: 8px;
  }
`;

const ModeHint = styled.span`
  font-size: 10px;
  color: ${theme.color.muted};
  margin-left: 4px;
`;

const PoolSelect = styled(Select)`
  width: 100%;
  font-size: 13px;
  padding: 7px 10px;
`;

const ResultValue = styled.div<{ tone?: 'profit' | 'loss' | 'normal' }>`
  font-size: 16px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: ${(props: { tone?: 'profit' | 'loss' | 'normal' }) =>
    props.tone === 'profit' ? theme.color.success : props.tone === 'loss' ? theme.color.danger : theme.color.text};
`;

const ChartWrap = styled.div`
  margin-top: 16px;
  background: ${theme.color.surface2};
  border-radius: ${theme.radius.md};
  padding: 12px 8px 8px;
`;

const ChartTitle = styled.div`
  font-size: 10px;
  color: ${theme.color.muted};
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin-bottom: 6px;
`;

const LoadingNote = styled.div`
  font-size: 11px;
  color: ${theme.color.muted};
  margin-bottom: 12px;
`;

// ---------------------------------------------------------------------------
// What-if slider sub-components
// ---------------------------------------------------------------------------

const SliderGrid = styled.div`
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  grid-gap: 12px;
  margin-bottom: 4px;
  @media (max-width: 600px) {
    grid-template-columns: 1fr;
  }
`;

const SliderWrap = styled.div`
  display: -webkit-box;
  display: flex;
  -webkit-box-orient: vertical;
  -webkit-box-direction: normal;
  flex-direction: column;
`;

const SliderHeader = styled.div`
  display: -webkit-box;
  display: flex;
  -webkit-box-align: center;
  align-items: center;
  -webkit-box-pack: justify;
  justify-content: space-between;
  margin-bottom: 4px;
`;

const SliderLabel = styled.span`
  font-size: 10px;
  color: ${theme.color.muted};
  text-transform: uppercase;
  letter-spacing: 0.05em;
`;

const SliderMultiplier = styled.span`
  font-size: 11px;
  color: ${theme.color.text};
  font-variant-numeric: tabular-nums;
  font-weight: 600;
`;

const SliderEffective = styled.div`
  font-size: 10px;
  color: ${theme.color.accent};
  margin-top: 3px;
  font-variant-numeric: tabular-nums;
`;

const ResetBtn = styled.button`
  background: transparent;
  border: none;
  color: ${theme.color.muted};
  font-size: 10px;
  cursor: pointer;
  padding: 0;
  margin-left: 6px;
  line-height: 1;
  text-decoration: underline;
  &:hover {
    color: ${theme.color.text};
  }
`;

const SliderInput = styled.input`
  width: 100%;
  cursor: pointer;
`;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const CUSTOM_POOL = '__custom__';

export const MiningCalculator: React.FC = () => {
  // Pre-filled from live BT data
  const [netHashStr, setNetHashStr] = useState('');
  const [rewardStr, setRewardStr] = useState('');
  const [priceStr, setPriceStr] = useState('');
  const [blockMinStr, setBlockMinStr] = useState('1.0');
  // User-entered
  const [yourHashStr, setYourHashStr] = useState('1000');
  const [wattsStr, setWattsStr] = useState('');
  const [kwhStr, setKwhStr] = useState('');
  const [loading, setLoading] = useState(true);

  // Solo vs pool mining
  const [mode, setMode] = useState<'solo' | 'pool'>('solo');
  const [poolList, setPoolList] = useState<ApiMiningPool[]>([]);
  const [poolId, setPoolId] = useState<string>('');
  const [feeStr, setFeeStr] = useState('1');

  // What-if sensitivity multipliers (1.0 = neutral)
  const [sliderNet, setSliderNet] = useState(1.0);
  const [sliderPrice, setSliderPrice] = useState(1.0);
  const [sliderKwh, setSliderKwh] = useState(1.0);

  // Fetch live data on mount — parallel calls to /api/mining/pools and /api/stats
  useEffect(() => {
    let alive = true;
    Promise.all([api.miningPools(), api.stats()])
      .then(([pools, stats]) => {
        if (!alive) return;
        if (pools.network_hashrate != null && Number.isFinite(pools.network_hashrate)) {
          setNetHashStr(String(Math.round(pools.network_hashrate)));
        }
        if (pools.block_height != null && pools.block_height > 0) {
          const r = blockRewardAtHeight(pools.block_height);
          if (Number.isFinite(r) && r > 0) setRewardStr(String(r));
        }
        if (stats.beam_usd != null && Number.isFinite(stats.beam_usd)) {
          setPriceStr(stats.beam_usd.toFixed(4));
        }
        const list = pools.pools ?? [];
        setPoolList(list);
        // Default to the largest pool by hashrate so the dropdown is never empty.
        const biggest = [...list].sort((a, b) => (b.hashrate ?? -1) - (a.hashrate ?? -1))[0];
        if (biggest) {
          setPoolId(biggest.id);
          if (biggest.fee != null) setFeeStr(String(biggest.fee));
        }
      })
      .catch(() => {
        // silent — leave fields blank/editable
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const selectedPool = useMemo(
    () => (poolId && poolId !== CUSTOM_POOL ? poolList.find((p) => p.id === poolId) ?? null : null),
    [poolId, poolList],
  );

  function onPoolChange(next: string) {
    setPoolId(next);
    const p = poolList.find((x) => x.id === next);
    if (p && p.fee != null) setFeeStr(String(p.fee));
  }

  const feePct = mode === 'pool' ? Math.min(safeNum(feeStr), 100) : 0;

  const baseInputs: CalcInputs = useMemo(
    () => ({
      netHash: safeNum(netHashStr),
      reward: safeNum(rewardStr),
      price: safeNum(priceStr),
      blockMin: safeNum(blockMinStr) || 1.0,
      yourHash: safeNum(yourHashStr),
      watts: safeNum(wattsStr),
      kwh: safeNum(kwhStr),
      feePct,
    }),
    [netHashStr, rewardStr, priceStr, blockMinStr, yourHashStr, wattsStr, kwhStr, feePct],
  );

  // Effective (multiplied) values fed into the formulas
  const effectiveNetHash = useMemo(() => baseInputs.netHash * sliderNet, [baseInputs.netHash, sliderNet]);
  const effectivePrice = useMemo(() => baseInputs.price * sliderPrice, [baseInputs.price, sliderPrice]);
  const effectiveKwh = useMemo(() => baseInputs.kwh * sliderKwh, [baseInputs.kwh, sliderKwh]);

  const inputs: CalcInputs = useMemo(
    () => ({
      ...baseInputs,
      netHash: effectiveNetHash,
      price: effectivePrice,
      kwh: effectiveKwh,
    }),
    [baseInputs, effectiveNetHash, effectivePrice, effectiveKwh],
  );

  const result = useMemo(() => {
    const { netHash, reward, price, yourHash } = inputs;
    if (netHash <= 0 || reward <= 0 || price <= 0 || yourHash <= 0) return null;
    return calc(inputs);
  }, [inputs]);

  const profitTone = !result
    ? 'normal'
    : result.dailyProfit > 0
    ? 'profit'
    : result.dailyProfit < 0
    ? 'loss'
    : 'normal';

  // Share of the selected pool's own hashrate (pool mode only).
  const poolShare =
    selectedPool && selectedPool.hashrate != null && selectedPool.hashrate > 0
      ? baseInputs.yourHash / selectedPool.hashrate
      : null;

  // Days until the pool's minimum payout threshold is reached.
  const minPayout = selectedPool?.min_payout ?? null;
  const secsToMinPayout =
    result && minPayout != null && minPayout > 0 && result.yourCoinsPerDay > 0
      ? (minPayout / result.yourCoinsPerDay) * 86400
      : null;

  return (
    <div>
      {loading && <LoadingNote>Loading live network data…</LoadingNote>}

      {/* Network / pre-filled inputs */}
      <SectionTitle>Network &amp; Market (auto-filled, editable)</SectionTitle>
      <FormGrid>
        <FieldWrap>
          <FieldLabel htmlFor="mc-nethash">Network Hashrate (Sol/s)</FieldLabel>
          <Input
            id="mc-nethash"
            type="number"
            min="0"
            step="any"
            value={netHashStr}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNetHashStr(e.target.value)}
            placeholder="e.g. 500000"
          />
          {safeNum(netHashStr) > 0 && <FieldHint>= {fmtHashrate(safeNum(netHashStr))}</FieldHint>}
        </FieldWrap>
        <FieldWrap>
          <FieldLabel htmlFor="mc-reward">Block Reward (BEAM)</FieldLabel>
          <Input
            id="mc-reward"
            type="number"
            min="0"
            step="any"
            value={rewardStr}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setRewardStr(e.target.value)}
            placeholder="e.g. 40"
          />
        </FieldWrap>
        <FieldWrap>
          <FieldLabel htmlFor="mc-price">BEAM Price (USD)</FieldLabel>
          <Input
            id="mc-price"
            type="number"
            min="0"
            step="any"
            value={priceStr}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPriceStr(e.target.value)}
            placeholder="e.g. 0.02"
          />
        </FieldWrap>
        <FieldWrap>
          <FieldLabel htmlFor="mc-blockmin">Block Time (min)</FieldLabel>
          <Input
            id="mc-blockmin"
            type="number"
            min="0.01"
            step="any"
            value={blockMinStr}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setBlockMinStr(e.target.value)}
            placeholder="1.0"
          />
        </FieldWrap>
      </FormGrid>

      {/* Solo vs pool */}
      <SectionTitle>Mining Mode</SectionTitle>
      <ModeRow>
        <TabBtn type="button" data-active={mode === 'solo'} onClick={() => setMode('solo')}>
          Solo
        </TabBtn>
        <TabBtn type="button" data-active={mode === 'pool'} onClick={() => setMode('pool')}>
          Pool
        </TabBtn>
        <ModeHint>
          {mode === 'solo'
            ? 'You keep the whole block reward, but payouts are all-or-nothing.'
            : 'Steady payouts, minus the pool fee.'}
        </ModeHint>
      </ModeRow>

      {mode === 'pool' && (
        <FormGrid>
          <FieldWrap>
            <FieldLabel htmlFor="mc-pool">Pool</FieldLabel>
            <PoolSelect
              id="mc-pool"
              value={poolId}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) => onPoolChange(e.target.value)}
            >
              {poolList.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.fee != null ? ` — ${p.fee}%` : ''}
                  {p.payout_scheme ? ` · ${p.payout_scheme}` : ''}
                </option>
              ))}
              <option value={CUSTOM_POOL}>Custom / other pool</option>
            </PoolSelect>
            <FieldHint>
              {selectedPool
                ? `${selectedPool.payout_scheme || 'unknown scheme'}${
                    selectedPool.hashrate != null ? ` · ${fmtHashrate(selectedPool.hashrate)}` : ''
                  }`
                : 'Enter the fee for your pool below.'}
            </FieldHint>
          </FieldWrap>
          <FieldWrap>
            <FieldLabel htmlFor="mc-fee">Pool Fee (%)</FieldLabel>
            <Input
              id="mc-fee"
              type="number"
              min="0"
              max="100"
              step="any"
              value={feeStr}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFeeStr(e.target.value)}
              placeholder="e.g. 1"
            />
            <FieldHint>Deducted from revenue. Editable — override for an unlisted pool.</FieldHint>
          </FieldWrap>
        </FormGrid>
      )}

      {/* User inputs */}
      <SectionTitle>Your Hardware</SectionTitle>
      <FormGrid>
        <FieldWrap>
          <FieldLabel htmlFor="mc-yourhash">Your Hashrate (Sol/s)</FieldLabel>
          <Input
            id="mc-yourhash"
            type="number"
            min="0"
            step="any"
            value={yourHashStr}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setYourHashStr(e.target.value)}
            placeholder="e.g. 1000"
          />
          {safeNum(yourHashStr) > 0 && <FieldHint>= {fmtHashrate(safeNum(yourHashStr))}</FieldHint>}
        </FieldWrap>
        <FieldWrap>
          <FieldLabel htmlFor="mc-watts">Power Consumption (W)</FieldLabel>
          <Input
            id="mc-watts"
            type="number"
            min="0"
            step="any"
            value={wattsStr}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setWattsStr(e.target.value)}
            placeholder="e.g. 200"
          />
        </FieldWrap>
        <FieldWrap>
          <FieldLabel htmlFor="mc-kwh">Electricity Cost (USD/kWh)</FieldLabel>
          <Input
            id="mc-kwh"
            type="number"
            min="0"
            step="any"
            value={kwhStr}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setKwhStr(e.target.value)}
            placeholder="e.g. 0.10"
          />
        </FieldWrap>
      </FormGrid>

      {/* What-if sensitivity sliders */}
      <SectionTitle>What-If Sensitivity</SectionTitle>
      <SliderGrid>
        {/* Network hashrate slider */}
        <SliderWrap>
          <SliderHeader>
            <SliderLabel>Network hashrate ×</SliderLabel>
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <SliderMultiplier>×{sliderNet.toFixed(2)}</SliderMultiplier>
              {sliderNet !== 1.0 && (
                <ResetBtn type="button" onClick={() => setSliderNet(1.0)}>
                  reset
                </ResetBtn>
              )}
            </div>
          </SliderHeader>
          <SliderInput
            type="range"
            min="0.5"
            max="2.0"
            step="0.01"
            value={sliderNet}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSliderNet(parseFloat(e.target.value))}
          />
          {baseInputs.netHash > 0 && <SliderEffective>={fmtHashrate(effectiveNetHash)}</SliderEffective>}
        </SliderWrap>

        {/* BEAM price slider */}
        <SliderWrap>
          <SliderHeader>
            <SliderLabel>BEAM price ×</SliderLabel>
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <SliderMultiplier>×{sliderPrice.toFixed(2)}</SliderMultiplier>
              {sliderPrice !== 1.0 && (
                <ResetBtn type="button" onClick={() => setSliderPrice(1.0)}>
                  reset
                </ResetBtn>
              )}
            </div>
          </SliderHeader>
          <SliderInput
            type="range"
            min="0.5"
            max="2.0"
            step="0.01"
            value={sliderPrice}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSliderPrice(parseFloat(e.target.value))}
          />
          {baseInputs.price > 0 && <SliderEffective>={fmtUsdLong(effectivePrice)}</SliderEffective>}
        </SliderWrap>

        {/* Electricity cost slider */}
        <SliderWrap>
          <SliderHeader>
            <SliderLabel>Electricity ×</SliderLabel>
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <SliderMultiplier>×{sliderKwh.toFixed(2)}</SliderMultiplier>
              {sliderKwh !== 1.0 && (
                <ResetBtn type="button" onClick={() => setSliderKwh(1.0)}>
                  reset
                </ResetBtn>
              )}
            </div>
          </SliderHeader>
          <SliderInput
            type="range"
            min="0.5"
            max="2.0"
            step="0.01"
            value={sliderKwh}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSliderKwh(parseFloat(e.target.value))}
          />
          {baseInputs.kwh > 0 && (
            <SliderEffective>
              ={fmtUsdLong(effectiveKwh)}
              /kWh
            </SliderEffective>
          )}
        </SliderWrap>
      </SliderGrid>

      {/* Results */}
      {result && (
        <>
          <SectionTitle>Results (per day)</SectionTitle>
          <StatGrid>
            <StatCard>
              <Label>Your BEAM / day</Label>
              <Value>{result.yourCoinsPerDay > 0 ? result.yourCoinsPerDay.toFixed(4) : '—'}</Value>
              <SubValue>
                {result.yourShare > 0 ? `${(result.yourShare * 100).toFixed(4)}% of network` : ''}
                {mode === 'pool' && poolShare != null
                  ? ` · ${(poolShare * 100).toFixed(2)}% of ${selectedPool?.name ?? 'pool'}`
                  : ''}
              </SubValue>
            </StatCard>
            <StatCard>
              <Label>Revenue / day</Label>
              <Value>{Number.isFinite(result.yourValuePerDay) ? fmtUsd(result.yourValuePerDay) : '—'}</Value>
              <SubValue>{mode === 'pool' && feePct > 0 ? `after ${feePct}% pool fee` : ''}</SubValue>
            </StatCard>
            <StatCard>
              <Label>Power cost / day</Label>
              <Value>{inputs.watts > 0 && effectiveKwh > 0 ? fmtUsd(result.dailyPowerCost) : '—'}</Value>
            </StatCard>
            <StatCard>
              <Label>Profit / day</Label>
              <ResultValue tone={profitTone}>
                {Number.isFinite(result.dailyProfit) ? fmtUsd(result.dailyProfit) : '—'}
              </ResultValue>
              <SubValue>
                {Number.isFinite(result.margin) && result.yourValuePerDay > 0
                  ? `${result.margin.toFixed(1)}% margin`
                  : ''}
              </SubValue>
            </StatCard>
          </StatGrid>

          <SectionTitle>{mode === 'pool' ? 'Payout' : 'Block'} &amp; Break-evens</SectionTitle>
          <StatGrid>
            {mode === 'pool' ? (
              <StatCard>
                <Label>Time to min payout</Label>
                <Value style={{ fontSize: 14 }}>{secsToMinPayout != null ? fmtDuration(secsToMinPayout) : '—'}</Value>
                <SubValue>
                  {minPayout != null && minPayout > 0 ? `${minPayout} BEAM minimum` : 'pool doesn\'t publish a minimum'}
                </SubValue>
              </StatCard>
            ) : (
              <StatCard>
                <Label>Time to find a block</Label>
                <Value style={{ fontSize: 14 }}>
                  {Number.isFinite(result.timeToBlockSecs) ? fmtDuration(result.timeToBlockSecs) : '—'}
                </Value>
                <SubValue>on average, at your share</SubValue>
              </StatCard>
            )}
            <StatCard>
              <Label>Break-even BEAM price</Label>
              <Value style={{ fontSize: 14 }}>{result.bePriceUsd > 0 ? fmtUsd(result.bePriceUsd) : '—'}</Value>
              <SubValue>at your power cost</SubValue>
            </StatCard>
            <StatCard>
              <Label>Break-even kWh price</Label>
              <Value style={{ fontSize: 14 }}>{result.beKwh > 0 ? fmtUsd(result.beKwh) : '—'}</Value>
              <SubValue>at current BEAM price</SubValue>
            </StatCard>
            <StatCard>
              <Label>Break-even network HR</Label>
              <Value style={{ fontSize: 14 }}>{result.beNetHash > 0 ? fmtHashrate(result.beNetHash) : '—'}</Value>
              <SubValue>max network to break even</SubValue>
            </StatCard>
          </StatGrid>

          {/* Profit vs network hashrate chart */}
          <ChartWrap>
            <ChartTitle>
              Profit / day vs Network Hashrate
              {mode === 'pool' && feePct > 0 ? ` (net of ${feePct}% fee)` : ''}
            </ChartTitle>
            <ProfitChart inputs={inputs} effectiveNetHash={effectiveNetHash} />
            <div
              style={{
                fontSize: 9,
                color: theme.color.muted,
                marginTop: 4,
                textAlign: 'center',
              }}
            >
              <span style={{ color: C_LINE, marginRight: 4 }}>—</span>
              profit curve
              <span style={{ marginLeft: 12, color: C_CURRENT, marginRight: 4 }}>- -</span>
              current network HR
              <span style={{ marginLeft: 12, color: C_ZERO, marginRight: 4 }}>- -</span>
              break-even ($0)
            </div>
          </ChartWrap>
        </>
      )}

      {!result && !loading && (
        <div style={{ fontSize: 11, color: theme.color.muted, marginTop: 8 }}>
          Fill in all fields above to see results.
        </div>
      )}
    </div>
  );
};
