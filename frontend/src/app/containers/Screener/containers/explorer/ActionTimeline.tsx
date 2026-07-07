import React, { useEffect, useMemo, useRef, useState } from 'react';
import { styled } from '@linaria/react';
import { theme } from './shared';
import { CATEGORIES, methodCategory, type BansCategory } from './bansActions';
import type { ApiBansAction } from '../../api/types';

const LANES = CATEGORIES;
const PAD_L = 92;
const PAD_R = 16;
const PAD_T = 8;
const PAD_B = 26;
const LANE_H = 28;

interface Tick { x: number; laneIdx: number; action: ApiBansAction; color: string; category: BansCategory; }

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

export const ActionTimeline: React.FC<{ actions: ApiBansAction[] }> = ({ actions }) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [hidden, setHidden] = useState<Set<BansCategory>>(new Set());
  const [hover, setHover] = useState<{ x: number; y: number; action: ApiBansAction } | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 0) setWidth(Math.floor(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const height = PAD_T + LANES.length * LANE_H + PAD_B;
  const plotW = Math.max(width - PAD_L - PAD_R, 10);
  const laneY = (i: number): number => PAD_T + i * LANE_H;

  const { ticks, minMs, maxMs } = useMemo(() => {
    const laneIndex = new Map(LANES.map((l, i) => [l.key, i] as const));
    const parsed = actions
      .map((a) => ({ a, ms: Date.parse(a.block_ts), cat: methodCategory(a.method) }))
      .filter((x) => Number.isFinite(x.ms) && laneIndex.has(x.cat));
    if (parsed.length === 0) return { ticks: [] as Tick[], minMs: 0, maxMs: 0 };
    let lo = Infinity; let hi = -Infinity;
    for (const p of parsed) { if (p.ms < lo) lo = p.ms; if (p.ms > hi) hi = p.ms; }
    if (hi === lo) hi = lo + 1;
    const out: Tick[] = parsed.map((p) => {
      const laneIdx = laneIndex.get(p.cat)!;
      return {
        x: PAD_L + ((p.ms - lo) / (hi - lo)) * plotW,
        laneIdx,
        action: p.a,
        color: LANES[laneIdx]!.color,
        category: p.cat,
      };
    });
    return { ticks: out, minMs: lo, maxMs: hi };
  }, [actions, plotW]);

  const gridlines = useMemo(() => {
    if (maxMs <= minMs) return [] as { x: number; label: string }[];
    const N = 6;
    return Array.from({ length: N + 1 }, (_, i) => ({
      x: PAD_L + (plotW * i) / N,
      label: fmtDate(minMs + ((maxMs - minMs) * i) / N),
    }));
  }, [minMs, maxMs, plotW]);

  const visibleTicks = useMemo(() => ticks.filter((t) => !hidden.has(t.category)), [ticks, hidden]);

  function onMove(e: React.MouseEvent<SVGSVGElement>): void {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const laneIdx = Math.floor((e.clientY - rect.top - PAD_T) / LANE_H);
    if (laneIdx < 0 || laneIdx >= LANES.length) { setHover(null); return; }
    let best: Tick | null = null;
    let bestDx = 12;
    for (const t of visibleTicks) {
      if (t.laneIdx !== laneIdx) continue;
      const dx = Math.abs(t.x - mx);
      if (dx < bestDx) { bestDx = dx; best = t; }
    }
    setHover(best ? { x: best.x, y: laneY(best.laneIdx) + LANE_H / 2, action: best.action } : null);
  }

  function toggle(cat: BansCategory): void {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat); else next.add(cat);
      return next;
    });
  }

  return (
    <Wrap ref={wrapRef}>
      <Legend>
        {LANES.map((l) => (
          <Chip key={l.key} type="button" data-off={hidden.has(l.key)} onClick={() => toggle(l.key)}>
            <Swatch style={{ background: l.color }} />
            {l.label}
          </Chip>
        ))}
      </Legend>

      <SvgWrap>
        <svg width={width} height={height} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
          {gridlines.map((g, i) => (
            <g key={`g${i}`}>
              <line x1={g.x} y1={PAD_T} x2={g.x} y2={PAD_T + LANES.length * LANE_H} stroke={theme.color.borderDim} strokeWidth={1} />
              <text x={g.x} y={height - 8} fill={theme.color.muted} fontSize={10} textAnchor="middle">{g.label}</text>
            </g>
          ))}
          {LANES.map((l, i) => (
            <g key={l.key}>
              <text x={PAD_L - 10} y={laneY(i) + LANE_H / 2 + 3} fill={theme.color.muted} fontSize={11} textAnchor="end">{l.label}</text>
              <line x1={PAD_L} y1={laneY(i) + LANE_H} x2={width - PAD_R} y2={laneY(i) + LANE_H} stroke={theme.color.borderDim} strokeWidth={1} opacity={0.5} />
            </g>
          ))}
          {visibleTicks.map((t, i) => (
            <line key={`t${i}`} x1={t.x} y1={laneY(t.laneIdx) + 4} x2={t.x} y2={laneY(t.laneIdx) + LANE_H - 4} stroke={t.color} strokeWidth={2} opacity={0.55} />
          ))}
          {hover && <circle cx={hover.x} cy={hover.y} r={3} fill={theme.color.text} />}
        </svg>

        {hover && (
          <Tip style={{ left: Math.min(hover.x + 10, Math.max(width - 170, 0)), top: hover.y - 6 }}>
            <TipName>{hover.action.name || '(no name)'}</TipName>
            <TipMeta>{hover.action.method} · h {hover.action.height}</TipMeta>
            <TipMeta>{fmtDate(Date.parse(hover.action.block_ts))}</TipMeta>
          </Tip>
        )}
      </SvgWrap>

      {ticks.length === 0 && <Empty>No actions to plot.</Empty>}
    </Wrap>
  );
};

export default ActionTimeline;

// --- styled ---------------------------------------------------------------
const Wrap = styled.div``;
const Legend = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  & > * + * { margin-left: 8px; }
  margin-bottom: 10px;
`;
const Chip = styled.button`
  display: inline-flex;
  align-items: center;
  & > * + * { margin-left: 6px; }
  background: ${theme.color.surface2};
  border: 1px solid ${theme.color.borderDim};
  border-radius: 6px;
  padding: 3px 8px;
  color: ${theme.color.text};
  font-size: 11px;
  cursor: pointer;
  &[data-off='true'] { opacity: 0.4; }
`;
const Swatch = styled.span`
  width: 10px;
  height: 10px;
  border-radius: 2px;
  display: inline-block;
`;
const SvgWrap = styled.div`
  position: relative;
  width: 100%;
  overflow-x: auto;
`;
const Tip = styled.div`
  position: absolute;
  pointer-events: none;
  z-index: 5;
  background: ${theme.color.surface3};
  border: 1px solid ${theme.color.border};
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 11px;
  color: ${theme.color.text};
  white-space: nowrap;
`;
const TipName = styled.div`
  color: ${theme.color.accent};
  font-weight: 600;
`;
const TipMeta = styled.div`
  color: ${theme.color.muted};
  font-size: 10px;
`;
const Empty = styled.div`
  padding: 20px;
  text-align: center;
  color: ${theme.color.muted};
  font-size: 12px;
`;
