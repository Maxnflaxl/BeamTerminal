// Engine-agnostic types for the comparison-points / deltas feature.
// Nothing here references pixels or a specific chart engine — everything works
// on (x-value, per-series value) tuples so both the SVG HdrsChart and (later) a
// lightweight-charts adapter can share it.

export type DeltaMode = 'consecutive' | 'baseline';

export interface SeriesDescriptor {
  /** Stable series id (HdrsChart: the column code). */
  id: string;
  label: string;
  color: string;
  /** Format an absolute value in this series' unit. */
  format: (v: number) => string;
  /** Format a signed delta (must include its own +/− sign) in this series' unit. */
  formatDelta: (dv: number) => string;
  /** Whether percentage deltas are meaningful (false for a timestamp series). */
  percentable: boolean;
}

/** A point resolved to its x identity + each series' value at that x. */
export interface ResolvedPoint {
  xValue: number;
  xLabel: string;
  values: Record<string, number>;
}

export interface DeltaCell {
  text: string;            // formatted value
  deltaText?: string;      // signed Δ vs the reference column (undefined for the reference itself)
  deltaPctText?: string;   // signed Δ% (omitted when !percentable or undefined ref)
  sign?: -1 | 0 | 1;       // drives arrow + colour
}

export interface DeltaColumn {
  xLabel: string;
  isToday: boolean;
  isBaseline?: boolean;
}

export interface DeltaRow {
  series: SeriesDescriptor;
  cells: DeltaCell[];       // one per column, aligned to DeltaTableModel.columns
}

export interface DeltaTableModel {
  columns: DeltaColumn[];   // points (x-sorted) … then today
  rows: DeltaRow[];         // one per series
}
