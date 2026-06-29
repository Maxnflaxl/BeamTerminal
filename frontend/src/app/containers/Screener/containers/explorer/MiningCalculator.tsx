// Mining profitability calculator — ported from 0xmx.net/mining/script.js?v=2
// Renders inside the Mining.tsx modal. No chart.js, no new npm deps.
// Chrome-83 / QtWebEngine 5.15.2 safe.

import React, { useEffect, useMemo, useState } from 'react';
import { styled } from '@linaria/react';
import { api } from '../../api/client';
import { blockRewardAtHeight } from './supplyMath';
import {
  StatGrid, StatCard, Label, Value, SubValue,
  Input, theme,
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
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtHashrate(solPerSec: number): string {
  if (!Number.isFinite(solPerSec) || solPerSec <= 0) return '—';
  const units = ['Sol/s', 'KSol/s', 'MSol/s', 'GSol/s'];
  let v = solPerSec;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  return v.toFixed(2) + ' ' + units[i];
}

function fmtDuration(secs: number): string {
  if (!Number.isFinite(secs) || secs <= 0) return '—';
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  const parts: string[] = [];
  if (d > 0) parts.push(d + 'd');
  if (h > 0) parts.push(h + 'h');
  if (m > 0) parts.push(m + 'm');
  if (s > 0 || parts.length === 0) parts.push(s + 's');
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Profit formula (ported verbatim from 0xmx.net)
// ---------------------------------------------------------------------------

interface CalcInputs {
  netHash: number;   // Sol/s
  reward: number;    // BEAM per block
  price: number;     // USD per BEAM
  blockMin: number;  // minutes per block
  yourHash: number;  // Sol/s
  watts: number;     // power consumption W
  kwh: number;       // electricity cost USD/kWh
}

interface CalcResult {
  blocksPerDay: number;
  networkCoinsPerDay: number;
  yourShare: number;
  yourCoinsPerDay: number;
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
  const { netHash, reward, price, blockMin, yourHash, watts, kwh } = inputs;
  const blockMinSafe = Math.max(blockMin, 1e-9);
  const blocksPerDay = 1440 / blockMinSafe;
  const networkCoinsPerDay = blocksPerDay * reward;
  const yourShare = (yourHash > 0 && netHash > 0) ? yourHash / netHash : 0;
  const yourCoinsPerDay = networkCoinsPerDay * yourShare;
  const yourValuePerDay = yourCoinsPerDay * price;
  const dailyPowerCost = (watts / 1000) * kwh * 24;
  const dailyProfit = yourValuePerDay - dailyPowerCost;
  const margin = yourValuePerDay > 0 ? 100 * dailyProfit / yourValuePerDay : 0;
  const timeToBlockSecs = (yourHash > 0 && netHash > 0) ? (netHash / yourHash) * blockMin * 60 : Infinity;
  const bePriceUsd = (yourCoinsPerDay > 0) ? dailyPowerCost / yourCoinsPerDay : 0;
  const beKwh = (watts > 0) ? yourValuePerDay / ((watts / 1000) * 24) : 0;
  const beNetHash = (price > 0 && dailyPowerCost > 0)
    ? (yourHash * networkCoinsPerDay * price) / dailyPowerCost
    : 0;
  return { blocksPerDay, networkCoinsPerDay, yourShare, yourCoinsPerDay, yourValuePerDay, dailyPowerCost, dailyProfit, margin, timeToBlockSecs, bePriceUsd, beKwh, beNetHash };
}

// ---------------------------------------------------------------------------
// Profit vs network hashrate SVG chart
// ---------------------------------------------------------------------------

interface ChartProps {
  inputs: CalcInputs;
}

const SVG_W = 560;
const SVG_H = 220;
const PAD = { top: 18, right: 20, bottom: 38, left: 68 };

const ProfitChart: React.FC<ChartProps> = ({ inputs }) => {
  const { netHash, reward, price, blockMin, yourHash, watts, kwh } = inputs;
  if (netHash <= 0 || yourHash <= 0 || reward <= 0) return null;

  const POINTS = 60;
  const xMin = netHash * 0.2;
  const xMax = netHash * 3.0;
  const xStep = (xMax - xMin) / (POINTS - 1);

  const pts: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < POINTS; i++) {
    const nh = xMin + i * xStep;
    const r = calc({ netHash: nh, reward, price, blockMin, yourHash, watts, kwh });
    pts.push({ x: nh, y: r.dailyProfit });
  }

  const yValues = pts.map((p) => p.y);
  const yMin = Math.min(...yValues);
  const yMax = Math.max(...yValues);
  const yRange = yMax - yMin || 1;

  const plotW = SVG_W - PAD.left - PAD.right;
  const plotH = SVG_H - PAD.top - PAD.bottom;

  const toSvgX = (nh: number) => PAD.left + ((nh - xMin) / (xMax - xMin)) * plotW;
  const toSvgY = (profit: number) => PAD.top + (1 - (profit - yMin) / yRange) * plotH;

  const pathD = pts
    .map((p, i) => (i === 0 ? 'M' : 'L') + ' ' + toSvgX(p.x).toFixed(1) + ' ' + toSvgY(p.y).toFixed(1))
    .join(' ');

  // y=0 line
  const y0 = toSvgY(0);
  const showZeroLine = y0 >= PAD.top && y0 <= PAD.top + plotH;

  // current netHash vertical line
  const xNetHash = toSvgX(netHash);

  // Y axis ticks
  const yTicks = [yMin, (yMin + yMax) / 2, yMax];
  // X axis ticks: xMin, netHash, xMax
  const xTicks = [xMin, netHash, xMax];

  function fmtAxisY(v: number) {
    if (Math.abs(v) < 0.01 && v !== 0) return v.toFixed(4);
    return (v >= 0 ? '' : '-') + '$' + Math.abs(v).toFixed(2);
  }

  function fmtAxisX(v: number) {
    if (v >= 1e9) return (v / 1e9).toFixed(1) + 'G Sol/s';
    if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M Sol/s';
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K Sol/s';
    return v.toFixed(0) + ' Sol/s';
  }

  return (
    <svg
      viewBox={'0 0 ' + SVG_W + ' ' + SVG_H}
      style={{ width: '100%', height: 'auto', display: 'block' }}
    >
      {/* Y axis ticks */}
      {yTicks.map((v, i) => {
        const sy = toSvgY(v);
        return (
          <g key={i}>
            <line x1={PAD.left - 4} y1={sy} x2={PAD.left} y2={sy} stroke="rgba(255,255,255,0.3)" strokeWidth="1" />
            <text x={PAD.left - 7} y={sy + 4} textAnchor="end" fontSize="9" fill="rgba(255,255,255,0.5)">{fmtAxisY(v)}</text>
          </g>
        );
      })}
      {/* X axis ticks */}
      {xTicks.map((v, i) => {
        const sx = toSvgX(v);
        return (
          <g key={i}>
            <line x1={sx} y1={PAD.top + plotH} x2={sx} y2={PAD.top + plotH + 4} stroke="rgba(255,255,255,0.3)" strokeWidth="1" />
            <text x={sx} y={PAD.top + plotH + 14} textAnchor="middle" fontSize="9" fill="rgba(255,255,255,0.5)">{fmtAxisX(v)}</text>
          </g>
        );
      })}
      {/* Axis labels */}
      <text x={PAD.left + plotW / 2} y={SVG_H - 2} textAnchor="middle" fontSize="9" fill="rgba(255,255,255,0.4)">Network hashrate (Sol/s)</text>
      <text x={10} y={PAD.top + plotH / 2} textAnchor="middle" fontSize="9" fill="rgba(255,255,255,0.4)" transform={'rotate(-90,' + 10 + ',' + (PAD.top + plotH / 2) + ')'}>Profit/day (USD)</text>
      {/* Plot border */}
      <rect x={PAD.left} y={PAD.top} width={plotW} height={plotH} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="1" />
      {/* y=0 dashed line */}
      {showZeroLine && (
        <line x1={PAD.left} y1={y0} x2={PAD.left + plotW} y2={y0} stroke="rgba(255,255,255,0.35)" strokeWidth="1" strokeDasharray="4 4" />
      )}
      {/* Current netHash vertical dashed line */}
      <line x1={xNetHash} y1={PAD.top} x2={xNetHash} y2={PAD.top + plotH} stroke="#00f6d2" strokeWidth="1" strokeDasharray="4 4" />
      {/* Curve */}
      <path d={pathD} fill="none" stroke="#00f6d2" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
};

// ---------------------------------------------------------------------------
// Styled sub-components
// ---------------------------------------------------------------------------

const FormGrid = styled.div`
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-bottom: 16px;
  @media (max-width: 600px) { grid-template-columns: 1fr; }
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

const ResultValue = styled.div<{ tone?: 'profit' | 'loss' | 'normal' }>`
  font-size: 16px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: ${(props: { tone?: 'profit' | 'loss' | 'normal' }) =>
    props.tone === 'profit' ? theme.color.success
    : props.tone === 'loss' ? theme.color.danger
    : theme.color.text};
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
// Component
// ---------------------------------------------------------------------------

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

  // Fetch live data on mount
  useEffect(() => {
    let alive = true;
    Promise.all([api.miningPools(), api.stats()]).then(([pools, stats]) => {
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
    }).catch(() => {
      // silent — leave fields blank/editable
    }).finally(() => {
      if (alive) setLoading(false);
    });
    return () => { alive = false; };
  }, []);

  const inputs: CalcInputs = useMemo(() => ({
    netHash: safeNum(netHashStr),
    reward: safeNum(rewardStr),
    price: safeNum(priceStr),
    blockMin: safeNum(blockMinStr) || 1.0,
    yourHash: safeNum(yourHashStr),
    watts: safeNum(wattsStr),
    kwh: safeNum(kwhStr),
  }), [netHashStr, rewardStr, priceStr, blockMinStr, yourHashStr, wattsStr, kwhStr]);

  const result = useMemo(() => {
    const { netHash, reward, price, yourHash } = inputs;
    if (netHash <= 0 || reward <= 0 || price <= 0 || yourHash <= 0) return null;
    return calc(inputs);
  }, [inputs]);

  const profitTone = !result ? 'normal'
    : result.dailyProfit > 0 ? 'profit'
    : result.dailyProfit < 0 ? 'loss'
    : 'normal';

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
          {safeNum(netHashStr) > 0 && (
            <span style={{ fontSize: 10, color: theme.color.muted, marginTop: 2 }}>
              = {fmtHashrate(safeNum(netHashStr))}
            </span>
          )}
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
          {safeNum(yourHashStr) > 0 && (
            <span style={{ fontSize: 10, color: theme.color.muted, marginTop: 2 }}>
              = {fmtHashrate(safeNum(yourHashStr))}
            </span>
          )}
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

      {/* Results */}
      {result && (
        <>
          <SectionTitle>Results (per day)</SectionTitle>
          <StatGrid>
            <StatCard>
              <Label>Your BEAM / day</Label>
              <Value>{result.yourCoinsPerDay > 0 ? result.yourCoinsPerDay.toFixed(4) : '—'}</Value>
              <SubValue>
                {result.yourShare > 0
                  ? (result.yourShare * 100).toFixed(4) + '% of network'
                  : ''}
              </SubValue>
            </StatCard>
            <StatCard>
              <Label>Revenue / day</Label>
              <Value>{Number.isFinite(result.yourValuePerDay) ? fmtUsd(result.yourValuePerDay) : '—'}</Value>
            </StatCard>
            <StatCard>
              <Label>Power cost / day</Label>
              <Value>{inputs.watts > 0 && inputs.kwh > 0 ? fmtUsd(result.dailyPowerCost) : '—'}</Value>
            </StatCard>
            <StatCard>
              <Label>Profit / day</Label>
              <ResultValue tone={profitTone}>
                {Number.isFinite(result.dailyProfit) ? fmtUsd(result.dailyProfit) : '—'}
              </ResultValue>
              <SubValue>
                {Number.isFinite(result.margin) && result.yourValuePerDay > 0
                  ? result.margin.toFixed(1) + '% margin'
                  : ''}
              </SubValue>
            </StatCard>
          </StatGrid>

          <SectionTitle>Block &amp; Break-evens</SectionTitle>
          <StatGrid>
            <StatCard>
              <Label>Time to find a block</Label>
              <Value style={{ fontSize: 14 }}>
                {Number.isFinite(result.timeToBlockSecs) ? fmtDuration(result.timeToBlockSecs) : '—'}
              </Value>
            </StatCard>
            <StatCard>
              <Label>Break-even BEAM price</Label>
              <Value style={{ fontSize: 14 }}>
                {result.bePriceUsd > 0 ? fmtUsd(result.bePriceUsd) : '—'}
              </Value>
              <SubValue>at your power cost</SubValue>
            </StatCard>
            <StatCard>
              <Label>Break-even kWh price</Label>
              <Value style={{ fontSize: 14 }}>
                {result.beKwh > 0 ? fmtUsd(result.beKwh) : '—'}
              </Value>
              <SubValue>at current BEAM price</SubValue>
            </StatCard>
            <StatCard>
              <Label>Break-even network HR</Label>
              <Value style={{ fontSize: 14 }}>
                {result.beNetHash > 0 ? fmtHashrate(result.beNetHash) : '—'}
              </Value>
              <SubValue>max network to break even</SubValue>
            </StatCard>
          </StatGrid>

          {/* Profit vs network hashrate chart */}
          <ChartWrap>
            <ChartTitle>Profit / day vs Network Hashrate</ChartTitle>
            <ProfitChart inputs={inputs} />
            <div style={{ fontSize: 9, color: theme.color.muted, marginTop: 4, textAlign: 'center' }}>
              <span style={{ color: '#00f6d2', marginRight: 4 }}>—</span>profit curve
              <span style={{ marginLeft: 12, color: '#00f6d2', marginRight: 4 }}>- -</span>current network HR
              <span style={{ marginLeft: 12, color: 'rgba(255,255,255,0.35)', marginRight: 4 }}>- -</span>break-even ($0)
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
