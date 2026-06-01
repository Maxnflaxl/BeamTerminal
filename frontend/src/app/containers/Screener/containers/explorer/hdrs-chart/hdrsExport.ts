// Export builders for the HdrsChart extended view. Generic download plumbing
// lives in chart-compare/download; this file only builds the CSV/SVG strings.

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
}

export interface HdrsSvgModel {
  title: string;
  width: number;
  height: number;
  series: HdrsSvgSeries[];
  xLabels: { x: number; text: string }[];          // x in [0, width]
  verticals: { x: number }[];                       // comparison-point lines, x in [0, width]
}

const escapeXml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

export function buildHdrsSvg(m: HdrsSvgModel): string {
  const { width: W, height: H } = m;
  const grid = 'rgba(255,255,255,0.06)';
  const label = 'rgba(255,255,255,0.6)';
  const gridLines = [0.25, 0.5, 0.75]
    .map((f) => `<line x1="0" y1="${(H * f).toFixed(1)}" x2="${W}" y2="${(H * f).toFixed(1)}" stroke="${grid}"/>`);
  const verticals = m.verticals
    .map((v) => `<line x1="${v.x.toFixed(1)}" y1="0" x2="${v.x.toFixed(1)}" y2="${H}" stroke="#00f6d2" stroke-width="1" stroke-dasharray="3 3"/>`);
  const paths = m.series
    .map((s) => `<path d="${s.path}" fill="none" stroke="${s.color}" stroke-width="1.6"/>`);
  const xLabels = m.xLabels
    .map((t, i, arr) => {
      const anchor = i === 0 ? 'start' : i === arr.length - 1 ? 'end' : 'middle';
      return `<text x="${t.x.toFixed(1)}" y="${H + 16}" text-anchor="${anchor}" fill="${label}" font-size="10">${escapeXml(t.text)}</text>`;
    });
  // Wrapped legend below the title.
  let lx = 8;
  const legend = m.series.map((s) => {
    const text = escapeXml(s.label);
    const seg = `<line x1="${lx}" y1="-8" x2="${lx + 12}" y2="-8" stroke="${s.color}" stroke-width="2"/>`
      + `<text x="${lx + 16}" y="-5" fill="${label}" font-size="10">${text}</text>`;
    lx += 26 + text.length * 6;
    return seg;
  });
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H + 60}" width="${W}" height="${H + 60}" font-family="sans-serif">`,
    `<rect x="-8" y="-28" width="${W + 16}" height="${H + 60}" fill="#042548"/>`,
    `<text x="0" y="-32" fill="rgba(255,255,255,0.7)" font-size="13">${escapeXml(m.title)}</text>`,
    ...legend,
    ...gridLines,
    ...verticals,
    ...paths,
    ...xLabels,
  ].join('') + '</svg>';
}
