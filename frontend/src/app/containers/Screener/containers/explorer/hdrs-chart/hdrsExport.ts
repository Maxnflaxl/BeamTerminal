// Export builders for the HdrsChart extended view. Generic download plumbing
// lives in chart-compare/download; this file only builds the CSV/SVG strings.

import type { DeltaMode, DeltaTableModel } from '../../../components/chart-compare/types';

export interface HdrsExportRow {
  height: number;
  ts: number | null;
  /** Raw value per plotted series id (column code); 'T' carries unix seconds. */
  values: Record<string, number>;
}

export interface HdrsExportSeries {
  id: string;
  label: string;
}

function csvField(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function buildHdrsCsv(rows: HdrsExportRow[], series: HdrsExportSeries[], title: string): string {
  const header = ['height', 'timestamp_iso', ...series.map((s) => csvField(s.label))];
  const lines = [`# ${title}`, header.join(',')];
  for (const r of rows) {
    const iso = typeof r.ts === 'number' ? new Date(r.ts * 1000).toISOString() : '';
    const cells = [String(r.height), iso, ...series.map((s) => String(r.values[s.id] ?? ''))];
    lines.push(cells.join(','));
  }
  return lines.join('\n') + '\n';
}

export interface HdrsSvgSeries {
  label: string;
  color: string;
  /** SVG path data already in the snapshot's coordinate space (see W/H below). */
  path: string;
  /** Per-series value-axis ticks: y in [0, height] (plot coords) + formatted label. */
  axis: { y: number; label: string }[];
}

export interface HdrsSvgModel {
  title: string;
  width: number;
  height: number;
  series: HdrsSvgSeries[];
  xLabels: { x: number; text: string }[];          // x in [0, width]
  verticals: { x: number; label?: string }[];       // comparison-point lines (+ date pill), x in [0, width]
  topPills?: { x: number; text: string }[];          // x-delta pills above the plot, x in [0, width]
  deltaTable?: DeltaTableModel;                       // per-series value/Δ table rendered below the chart
  deltaMode?: DeltaMode;                              // labels the table header (Consecutive / Baseline)
}

const escapeXml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

export function buildHdrsSvg(m: HdrsSvgModel): string {
  const { width: W, height: H } = m;
  const grid = 'rgba(255,255,255,0.06)';
  const label = 'rgba(255,255,255,0.6)';
  const AX = 86; // per-series right-edge value-axis column width
  const totalW = W + m.series.length * AX;
  const gridLines = [0.25, 0.5, 0.75]
    .map((f) => `<line x1="0" y1="${(H * f).toFixed(1)}" x2="${W}" y2="${(H * f).toFixed(1)}" stroke="${grid}"/>`);
  const verticals = m.verticals.map((v) => {
    const line = `<line x1="${v.x.toFixed(1)}" y1="0" x2="${v.x.toFixed(1)}" y2="${H}" stroke="#00f6d2" stroke-width="1.2"/>`;
    if (!v.label) return line;
    // Accent date pill at the bottom of the marker — mirrors the live chart.
    const w = v.label.length * 5.4 + 8;
    return line
      + `<rect x="${(v.x - w / 2).toFixed(1)}" y="${(H - 6).toFixed(1)}" width="${w.toFixed(1)}" height="13" rx="3" fill="#00f6d2"/>`
      + `<text x="${v.x.toFixed(1)}" y="${(H + 3.5).toFixed(1)}" text-anchor="middle" fill="#04222f" font-size="9" font-weight="600">${escapeXml(v.label)}</text>`;
  });
  const paths = m.series
    .map((s) => `<path d="${s.path}" fill="none" stroke="${s.color}" stroke-width="1.6"/>`);
  const xLabels = m.xLabels
    .map((t, i, arr) => {
      const anchor = i === 0 ? 'start' : i === arr.length - 1 ? 'end' : 'middle';
      return `<text x="${t.x.toFixed(1)}" y="${H + 16}" text-anchor="${anchor}" fill="${label}" font-size="10">${escapeXml(t.text)}</text>`;
    });
  // Per-series right-edge value axes (one column each, in series colour) — mirrors
  // the live chart's independent per-series axes so the export isn't axis-less.
  const axes: string[] = [];
  m.series.forEach((s, i) => {
    if (!s.axis || s.axis.length === 0) return;
    const x0 = W + i * AX + 4;
    const ys = s.axis.map((a) => a.y);
    axes.push(`<line x1="${x0}" y1="${Math.min(...ys).toFixed(1)}" x2="${x0}" y2="${Math.max(...ys).toFixed(1)}" stroke="${s.color}" stroke-width="1.5"/>`);
    for (const a of s.axis) {
      axes.push(
        `<line x1="${x0}" y1="${a.y.toFixed(1)}" x2="${x0 + 5}" y2="${a.y.toFixed(1)}" stroke="${s.color}" stroke-width="1.5"/>`
        + `<text x="${x0 + 8}" y="${a.y.toFixed(1)}" fill="${s.color}" font-size="9" dominant-baseline="middle">${escapeXml(a.label)}</text>`,
      );
    }
  });
  // Top x-delta pills (between adjacent markers), drawn at the top of the plot.
  const topPills = (m.topPills || []).map((p) => {
    const w = p.text.length * 5.4 + 8;
    return `<rect x="${(p.x - w / 2).toFixed(1)}" y="2" width="${w.toFixed(1)}" height="13" rx="3" fill="#00f6d2"/>`
      + `<text x="${p.x.toFixed(1)}" y="11.5" text-anchor="middle" fill="#04222f" font-size="9" font-weight="600">${escapeXml(p.text)}</text>`;
  });
  // Layout bands: TOP holds the title + wrapped legend, BOT the x-axis labels,
  // TABLE the per-series delta readout. Plot content (authored in 0..W × 0..H)
  // is translated into the plot band; everything stays within the viewBox.
  const TOP = 44;
  const BOT = 24;
  const dt = m.deltaTable;
  const tableRows = dt ? dt.rows.length : 0;
  const ROWH = 26;
  const tableH = tableRows > 0 ? 22 + tableRows * ROWH : 0;
  const totalH = TOP + H + BOT + tableH;
  // Per-series delta table below the chart (mirrors the on-screen DeltaPanel).
  const tableEls: string[] = [];
  if (dt && tableRows > 0) {
    const yT = TOP + H + BOT;
    const dataLeft = 8 + 96; // 96px series-label column
    const colW = (W - 8 - dataLeft) / dt.columns.length;
    const colRight = (i: number): number => dataLeft + (i + 1) * colW - 6;
    const modeLabel = m.deltaMode === 'baseline' ? 'Baseline' : 'Consecutive';
    tableEls.push(`<text x="8" y="${yT + 12}" fill="${label}" font-size="10" font-weight="600">Series (${modeLabel})</text>`);
    dt.columns.forEach((c, i) => {
      const head = (c.isBaseline ? '◎ ' : '') + (c.isToday ? 'today' : c.xLabel);
      tableEls.push(`<text x="${colRight(i).toFixed(1)}" y="${yT + 12}" text-anchor="end" fill="${c.isToday ? '#00f6d2' : label}" font-size="9" font-weight="600">${escapeXml(head)}</text>`);
    });
    tableEls.push(`<line x1="8" y1="${yT + 16}" x2="${W - 8}" y2="${yT + 16}" stroke="rgba(255,255,255,0.1)"/>`);
    dt.rows.forEach((row, r) => {
      const ry = yT + 32 + r * ROWH;
      tableEls.push(`<text x="8" y="${ry.toFixed(1)}" fill="${row.series.color}" font-size="10" font-weight="600">${escapeXml(row.series.label)}</text>`);
      row.cells.forEach((cell, i) => {
        tableEls.push(`<text x="${colRight(i).toFixed(1)}" y="${ry.toFixed(1)}" text-anchor="end" fill="#ffffff" font-size="10">${escapeXml(cell.text)}</text>`);
        if (cell.deltaText) {
          const dc = cell.sign === 1 ? '#00f6d2' : cell.sign === -1 ? '#f25f5b' : label;
          const arrow = cell.sign === 1 ? '▲ ' : cell.sign === -1 ? '▼ ' : '';
          const pct = cell.deltaPctText ? ` (${cell.deltaPctText})` : '';
          tableEls.push(`<text x="${colRight(i).toFixed(1)}" y="${(ry + 11).toFixed(1)}" text-anchor="end" fill="${dc}" font-size="8">${escapeXml(arrow + cell.deltaText + pct)}</text>`);
        }
      });
    });
  }
  // Wrapped legend just under the title.
  let lx = 8;
  const legend = m.series.map((s) => {
    const text = escapeXml(s.label);
    const seg = `<line x1="${lx}" y1="31" x2="${lx + 12}" y2="31" stroke="${s.color}" stroke-width="2"/>`
      + `<text x="${lx + 16}" y="34" fill="${label}" font-size="10">${text}</text>`;
    lx += 26 + text.length * 6;
    return seg;
  });
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalW} ${totalH}" width="${totalW}" height="${totalH}" font-family="sans-serif">`,
    `<rect x="0" y="0" width="${totalW}" height="${totalH}" fill="#042548"/>`,
    `<text x="8" y="18" fill="rgba(255,255,255,0.7)" font-size="13">${escapeXml(m.title)}</text>`,
    ...legend,
    `<g transform="translate(0 ${TOP})">`,
    ...gridLines,
    ...verticals,
    ...paths,
    ...xLabels,
    ...axes,
    ...topPills,
    `</g>`,
    ...tableEls,
  ].join('') + '</svg>';
}
