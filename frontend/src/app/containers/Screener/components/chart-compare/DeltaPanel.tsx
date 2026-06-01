import React from 'react';
import type { DeltaMode, DeltaTableModel } from './types';

// Chrome-83-safe palette mirroring explorer/shared/theme.ts + styles.ts (the
// same hex values NetworkCharts/chartTheme.ts already hardcode). Kept local so
// this shared module doesn't back-import a container's theme.
const C = {
  text: '#ffffff',
  muted: 'rgba(255,255,255,0.5)',
  border: 'rgba(255,255,255,0.1)',
  accent: '#00f6d2',
  danger: '#f25f5b',
  todayBg: 'rgba(0,246,210,0.06)',
};

const arrow = (sign?: -1 | 0 | 1): string => (sign === 1 ? '▲ ' : sign === -1 ? '▼ ' : '');
const deltaColor = (sign?: -1 | 0 | 1): string => (sign === 1 ? C.accent : sign === -1 ? C.danger : C.muted);

const th: React.CSSProperties = {
  fontSize: 10, color: C.muted, fontWeight: 600, padding: '4px 8px',
  textAlign: 'right', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums',
  borderBottom: `1px solid ${C.border}`, cursor: 'default',
};
const td: React.CSSProperties = {
  fontSize: 11, padding: '3px 8px', textAlign: 'right', whiteSpace: 'nowrap',
  fontVariantNumeric: 'tabular-nums',
};

export const DeltaPanel: React.FC<{
  model: DeltaTableModel;
  mode: DeltaMode;
  onModeChange: (m: DeltaMode) => void;
  // Baseline state is already encoded in model.columns[i].isBaseline; the panel
  // only needs to report which column the user clicked.
  onBaselineChange: (i: number) => void;
}> = ({ model, mode, onModeChange, onBaselineChange }) => {
  if (model.rows.length === 0 && model.columns.length === 0) return null;
  return (
    <div style={{ margin: '8px 0 2px', overflowX: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
        <span style={{ fontSize: 11, color: C.muted, marginRight: 10 }}>Deltas</span>
        {(['consecutive', 'baseline'] as DeltaMode[]).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => onModeChange(m)}
            style={{
              background: mode === m ? C.accent : 'transparent',
              color: mode === m ? '#04222f' : C.muted,
              border: `1px solid ${mode === m ? C.accent : C.border}`,
              borderRadius: 4, font: 'inherit', fontSize: 11, lineHeight: 1,
              padding: '3px 8px', marginRight: 6, cursor: 'pointer',
            }}
          >
            {m === 'consecutive' ? 'Consecutive' : 'Baseline'}
          </button>
        ))}
        {mode === 'baseline' && (
          <span style={{ fontSize: 10, color: C.muted, marginLeft: 4 }}>
            click a column header to re-base
          </span>
        )}
      </div>
      <table style={{ borderCollapse: 'collapse', minWidth: '100%' }}>
        <thead>
          <tr>
            <th style={{ ...th, textAlign: 'left' }}>Series</th>
            {model.columns.map((c, i) => (
              <th
                key={i}
                style={{
                  ...th,
                  color: c.isToday ? C.accent : c.isBaseline ? C.text : C.muted,
                  background: c.isToday ? C.todayBg : undefined,
                  cursor: mode === 'baseline' && !c.isToday ? 'pointer' : 'default',
                }}
                onClick={() => { if (mode === 'baseline' && !c.isToday) onBaselineChange(i); }}
                title={mode === 'baseline' && !c.isToday ? 'Set as baseline' : undefined}
              >
                {c.isBaseline ? '◎ ' : ''}{c.isToday ? 'today' : c.xLabel}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {model.rows.map((r) => (
            <tr key={r.series.id}>
              <td style={{ ...td, textAlign: 'left', color: r.series.color, fontWeight: 600 }}>
                {r.series.label}
              </td>
              {r.cells.map((cell, i) => (
                <td key={i} style={{ ...td, background: model.columns[i]?.isToday ? C.todayBg : undefined }}>
                  <span style={{ color: C.text }}>{cell.text}</span>
                  {cell.deltaText && (
                    <span style={{ color: deltaColor(cell.sign), display: 'block', fontSize: 10 }}>
                      {arrow(cell.sign)}{cell.deltaText}
                      {cell.deltaPctText ? ` (${cell.deltaPctText})` : ''}
                    </span>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
