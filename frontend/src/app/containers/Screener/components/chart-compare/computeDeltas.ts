import type {
  DeltaCell, DeltaMode, DeltaTableModel, ResolvedPoint, SeriesDescriptor,
} from './types';

function signOf(d: number): -1 | 0 | 1 {
  return d > 0 ? 1 : d < 0 ? -1 : 0;
}

function pctText(from: number, to: number): string | undefined {
  if (!Number.isFinite(from) || from === 0) return undefined;
  const p = ((to - from) / Math.abs(from)) * 100;
  const abs = Math.abs(p);
  return `${p >= 0 ? '+' : ''}${p.toFixed(abs >= 100 ? 0 : 1)}%`;
}

// Build the delta table. `points` must be x-sorted and exclude today; `today` is
// appended as the final column. Consecutive: each column's Δ is vs the column to
// its left. Baseline: each non-baseline column's Δ is vs the baseline column.
export function computeDeltas(
  points: ResolvedPoint[],
  today: ResolvedPoint,
  series: SeriesDescriptor[],
  mode: DeltaMode,
  baselineIndex: number,
): DeltaTableModel {
  const cols = [...points, today];
  const todayIdx = cols.length - 1;
  const baseIdx = Math.max(0, Math.min(baselineIndex, cols.length - 1));

  const columns = cols.map((p, i) => ({
    xLabel: p.xLabel,
    isToday: i === todayIdx,
    isBaseline: mode === 'baseline' && i === baseIdx,
  }));

  const rows = series.map((s) => {
    const cells: DeltaCell[] = cols.map((p, i) => {
      const v = p.values[s.id] ?? 0;
      const cell: DeltaCell = { text: s.format(v) };
      let refIdx = -1;
      if (mode === 'consecutive') refIdx = i - 1;
      else if (i !== baseIdx) refIdx = baseIdx;
      if (refIdx >= 0) {
        const ref = cols[refIdx].values[s.id] ?? 0;
        const dv = v - ref;
        cell.deltaText = s.formatDelta(dv);
        cell.sign = signOf(dv);
        if (s.percentable) cell.deltaPctText = pctText(ref, v);
      }
      return cell;
    });
    return { series: s, cells };
  });

  return { columns, rows };
}
