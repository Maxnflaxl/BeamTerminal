import React, { useEffect, useMemo, useState } from 'react';
import { styled } from '@linaria/react';
import { api } from '../../api/client';
import type { ApiMiningPools, ApiMiningPool } from '../../api/types';
import {
  Page, Card, H2, StatGrid, StatCard, Label, Value, DataTable, Dot, Muted, theme,
} from './shared';
import { blockRewardAtHeight } from './supplyMath';

// --- helpers ---------------------------------------------------------------
function fmtHashrate(solPerSec: number | null): string {
  if (solPerSec == null || !Number.isFinite(solPerSec)) return '—';
  const units = ['Sol/s', 'KSol/s', 'MSol/s', 'GSol/s'];
  let v = solPerSec;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  return `${v.toFixed(2)} ${units[i]}`;
}
function fmtAge(iso: string | null): string {
  if (!iso) return '—';
  const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 90) return `${Math.round(secs)}s ago`;
  if (secs < 5400) return `${Math.round(secs / 60)}m ago`;
  if (secs < 129600) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}
const COLORS = ['#00f6d2', '#4f9dff', '#ffb454', '#ff6b9d', '#a78bfa', '#34d399', '#f87171', '#94a3b8'];

// --- donut -----------------------------------------------------------------
interface Slice { label: string; value: number; color: string }
const Donut: React.FC<{ slices: Slice[]; size?: number }> = ({ slices, size = 220 }) => {
  const total = slices.reduce((s, x) => s + x.value, 0) || 1;
  const r = size / 2;
  const stroke = size * 0.18;
  const radius = r - stroke / 2;
  const circ = 2 * Math.PI * radius;
  let offset = 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <g transform={`rotate(-90 ${r} ${r})`}>
        {slices.map((s, i) => {
          const frac = s.value / total;
          const len = frac * circ;
          const el = (
            <circle
              key={i}
              cx={r} cy={r} r={radius}
              fill="none" stroke={s.color} strokeWidth={stroke}
              strokeDasharray={`${len} ${circ - len}`}
              strokeDashoffset={-offset}
            />
          );
          offset += len;
          return el;
        })}
      </g>
    </svg>
  );
};

const Layout = styled.div`
  display: grid;
  grid-template-columns: 220px 1fr;
  gap: 24px;
  align-items: center;
  @media (max-width: 600px) { grid-template-columns: 1fr; }
`;
const Legend = styled.ul`
  list-style: none; margin: 0; padding: 0;
  li { display: -webkit-box; display: flex; -webkit-box-align: center; align-items: center; padding: 4px 0; font-size: 14px; }
  li > * + * { margin-left: 8px; }
  span.dot { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
  span.pct { margin-left: auto; opacity: 0.7; }
`;
const Calc = styled.div`
  display: -webkit-box;
  display: flex;
  -webkit-box-align: end;
  align-items: flex-end;
  flex-wrap: wrap;
  > * + * { margin-left: 12px; }
  label { display: -webkit-box; display: flex; -webkit-box-orient: vertical; -webkit-box-direction: normal; flex-direction: column; font-size: 13px; }
  label > * + * { margin-top: 4px; }
  input { background: ${theme.color.surface2}; border: 1px solid ${theme.color.border};
          color: ${theme.color.text}; padding: 8px; border-radius: ${theme.radius.sm};
          font-family: ${theme.font.mono}; min-width: 160px; }
`;

// 1440 blocks/day (BEAM ~1 min blocks)
const BLOCKS_PER_DAY = 1440;

export const Mining: React.FC = () => {
  const [data, setData] = useState<ApiMiningPools | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [hr, setHr] = useState('1000'); // KSol/s input
  const [price, setPrice] = useState<number | null>(null);
  const [height, setHeight] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      api.miningPools()
        .then((d) => { if (alive) { setData(d); setErr(null); } })
        .catch((e) => { if (alive) setErr(e?.message ?? 'failed to load'); });
    };
    load();
    const t = setInterval(load, 60_000);
    api.stats().then((s: any) => {
      if (alive) {
        setPrice(typeof s?.beam_usd === 'number' ? s.beam_usd : null);
        setHeight(typeof s?.last_indexed_height === 'number' ? s.last_indexed_height : null);
      }
    }).catch(() => {});
    return () => { alive = false; clearInterval(t); };
  }, []);

  const network = data?.network_hashrate ?? null;
  const pools = data?.pools ?? [];

  // Sort: online (non-null hashrate) descending, offline last
  const sorted = useMemo(
    () => [...pools].sort((a, b) => (b.hashrate ?? -1) - (a.hashrate ?? -1)),
    [pools],
  );

  const slices: Slice[] = useMemo(() => {
    const known = sorted.filter((p) => p.hashrate != null && p.hashrate > 0);
    const sumKnown = known.reduce((s, p) => s + (p.hashrate ?? 0), 0);
    const out: Slice[] = known.map((p, i) => ({ label: p.name, value: p.hashrate ?? 0, color: COLORS[i % COLORS.length] }));
    if (network != null && network > sumKnown) {
      out.push({ label: 'Unknown / solo', value: network - sumKnown, color: COLORS[7] });
    }
    return out;
  }, [sorted, network]);
  const sliceTotal = slices.reduce((s, x) => s + x.value, 0) || 1;

  // calculator — use halving-aware reward when height is known
  const blockReward = height != null ? blockRewardAtHeight(height) : 40;
  const userSol = (parseFloat(hr) || 0) * 1000; // KSol/s -> Sol/s
  const share = network && network > 0 ? userSol / network : 0;
  const dailyBeam = share * BLOCKS_PER_DAY * blockReward;
  const dailyUsd = price != null ? dailyBeam * price : null;

  return (
    <Page>
      <H2>Mining</H2>
      {err && <Card>Failed to load mining data: {err}</Card>}

      <StatGrid>
        <StatCard><Label>Network hashrate</Label><Value>{fmtHashrate(network)}</Value></StatCard>
        <StatCard><Label>Pools tracked</Label><Value>{pools.length}</Value></StatCard>
        <StatCard><Label>Active miners</Label><Value>{pools.reduce((s, p) => s + (p.miners ?? 0), 0)}</Value></StatCard>
      </StatGrid>

      <Card>
        <H2>Hashrate distribution</H2>
        {slices.length === 0 ? (
          <Muted>No pool data available</Muted>
        ) : (
          <Layout>
            <Donut slices={slices} />
            <Legend>
              {slices.map((s, i) => (
                <li key={i}>
                  <span className="dot" style={{ background: s.color }} />
                  {s.label}
                  <span className="pct">{((s.value / sliceTotal) * 100).toFixed(1)}%</span>
                </li>
              ))}
            </Legend>
          </Layout>
        )}
      </Card>

      <Card>
        <H2>Pools</H2>
        <DataTable>
          <thead>
            <tr>
              <th>Pool</th><th>Fee</th><th>Payout</th><th>Min payout</th>
              <th>Miners</th><th>Hashrate</th><th>% net</th><th>Last block</th><th></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((p: ApiMiningPool) => {
              const offline = p.hashrate == null;
              const pct = network && p.hashrate ? (p.hashrate / network) * 100 : null;
              return (
                <tr key={p.id}>
                  <td><a href={p.website} target="_blank" rel="noreferrer">{p.name}</a></td>
                  <td>{p.fee != null ? `${p.fee}%` : '—'}</td>
                  <td>{p.payout_scheme}</td>
                  <td>{p.min_payout != null ? `${p.min_payout} BEAM` : '—'}</td>
                  <td>{p.miners ?? '—'}</td>
                  <td>{fmtHashrate(p.hashrate)}</td>
                  <td>{pct != null ? `${pct.toFixed(1)}%` : '—'}</td>
                  <td>{fmtAge(p.last_block_ts)}</td>
                  <td><Dot data-kind={offline ? 'error' : 'live'} /></td>
                </tr>
              );
            })}
          </tbody>
        </DataTable>
      </Card>

      <Card>
        <H2>Profitability calculator</H2>
        <Calc>
          <label>Your hashrate (KSol/s)
            <input value={hr} onChange={(e) => setHr(e.target.value)} inputMode="decimal" />
          </label>
          <StatCard><Label>Est. daily BEAM</Label><Value>{dailyBeam.toFixed(2)}</Value></StatCard>
          <StatCard><Label>Est. daily USD</Label><Value>{dailyUsd != null ? `$${dailyUsd.toFixed(2)}` : '—'}</Value></StatCard>
        </Calc>
      </Card>
    </Page>
  );
};
