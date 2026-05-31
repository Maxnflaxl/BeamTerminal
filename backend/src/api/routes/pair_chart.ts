import type { FastifyInstance } from 'fastify';
import { Resvg } from '@resvg/resvg-js';
import { z } from 'zod';
import { q } from '../../db.js';
import { BadRequest } from '../error.js';
import { resolvePair } from '../repos/pairs.js';
import { fetchCandles, densifyCandles, INTERVALS, type Interval } from '../repos/ohlcv.js';

/**
 * GET /pair/:id/chart.png
 *
 * Server-rendered price chart for use in chat bots (Telegram /c, Discord /c).
 * SVG generator is a port of the frontend's `toSvg()` in
 * `frontend/src/app/containers/Screener/containers/NetworkCharts.tsx`, so the
 * server-rendered output matches the website's PNG chart export pixel-for-pixel.
 *
 * Registered WITHOUT the /api prefix (matches og.ts) — image assets get short,
 * CDN-cacheable URLs and chat clients/OG crawlers prefer the bare path.
 */

const Query = z.object({
  days: z
    .union([z.literal('all'), z.coerce.number().int().positive().max(3650)])
    .default(1),
  w: z.coerce.number().int().min(200).max(2000).default(720),
  h: z.coerce.number().int().min(150).max(1200).default(360),
});

/** Picks the densest interval/limit pair that keeps the chart readable across
 *  ranges. Mirrors the frontend's pair-detail chart granularity. */
function rangeToCandles(days: number | 'all'): { interval: Interval; limit: number } {
  if (days === 'all' || days > 365) return { interval: '1d', limit: 2000 };
  if (days <= 1) return { interval: '5m', limit: 288 };
  if (days <= 7) return { interval: '1h', limit: days * 24 };
  if (days <= 90) return { interval: '4h', limit: days * 6 };
  return { interval: '1d', limit: days };
}

const escapeXml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** `count` evenly-spaced values across [min, max], inclusive of both ends. */
function axisTicks(min: number, max: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => min + ((max - min) * i) / (count - 1));
}

/** USD price formatter that degrades gracefully across magnitudes — from
 *  multi-million dollars down to memecoin-scale `$3.339E-8`. */
function fmtPrice(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return '$0';
  if (v >= 1)    return '$' + v.toFixed(2);
  if (v >= 0.01) return '$' + v.toFixed(4);
  if (v >= 1e-3) return '$' + v.toFixed(5);
  if (v >= 1e-6) return '$' + v.toFixed(8);
  return '$' + v.toExponential(3).replace('e', 'E');
}

/** Axis date label that adapts to the visible range. Sub-2-day windows show
 *  HH:MM (the frontend's daily ISO label would print the same date 5×); wider
 *  windows fall back to the frontend's ISO YYYY-MM-DD format. */
function fmtAxisDate(epoch: number, rangeSeconds: number): string {
  const d = new Date(epoch * 1000);
  if (rangeSeconds < 2 * 86_400) return d.toISOString().slice(11, 16);
  return d.toISOString().slice(0, 10);
}

interface SvgOpts {
  series: ReadonlyArray<{ t: number; v: number }>;
  title: string;
  width: number;
  height: number;
}

/**
 * Direct port of `toSvg()` from
 * frontend/src/app/containers/Screener/containers/NetworkCharts.tsx.
 * Same palette, padding, font, grid, and stroke so the bot output matches
 * the frontend's "Download PNG" export.
 */
function renderChartSvg(o: SvgOpts): string {
  const W = o.width;
  const H = o.height;
  const pad = { l: 64, r: 16, t: 32, b: 32 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;
  const grid = 'rgba(255,255,255,0.06)';
  const label = 'rgba(255,255,255,0.6)';

  if (o.series.length < 2) {
    return [
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="sans-serif" font-size="11">`,
      `<rect width="${W}" height="${H}" fill="#042548"/>`,
      `<text x="${pad.l}" y="20" fill="rgba(255,255,255,0.7)" font-size="13">${escapeXml(o.title)}</text>`,
      `<text x="${(W / 2).toFixed(1)}" y="${(H / 2).toFixed(1)}" text-anchor="middle" fill="${label}" font-size="16">No trades in range</text>`,
      `</svg>`,
    ].join('');
  }

  const xs = o.series.map((p) => p.t);
  const ys = o.series.map((p) => p.v);
  const xMin = xs[0]!;
  const xMax = xs[xs.length - 1]!;
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const xRange = Math.max(1, xMax - xMin);
  const yRange = Math.max(Number.EPSILON, yMax - yMin);
  const px = (t: number): number => pad.l + ((t - xMin) / xRange) * innerW;
  const py = (v: number): number => pad.t + innerH - ((v - yMin) / yRange) * innerH;

  const yGrid = axisTicks(yMin, yMax, 5).map((v) => {
    const y = py(v).toFixed(1);
    return (
      `<line x1="${pad.l}" y1="${y}" x2="${pad.l + innerW}" y2="${y}" stroke="${grid}"/>` +
      `<text x="${pad.l - 6}" y="${(py(v) + 3).toFixed(1)}" text-anchor="end" fill="${label}">${escapeXml(fmtPrice(v))}</text>`
    );
  });
  const xGrid = axisTicks(xMin, xMax, 5).map((t, i, arr) => {
    const x = px(t).toFixed(1);
    const anchor = i === 0 ? 'start' : i === arr.length - 1 ? 'end' : 'middle';
    const lbl = fmtAxisDate(t, xRange);
    return (
      `<line x1="${x}" y1="${pad.t}" x2="${x}" y2="${pad.t + innerH}" stroke="${grid}"/>` +
      `<text x="${x}" y="${pad.t + innerH + 18}" text-anchor="${anchor}" fill="${label}">${lbl}</text>`
    );
  });
  const path = o.series
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${px(p.t).toFixed(1)},${py(p.v).toFixed(1)}`)
    .join(' ');

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="sans-serif" font-size="11">`,
    `<rect width="${W}" height="${H}" fill="#042548"/>`,
    `<text x="${pad.l}" y="20" fill="rgba(255,255,255,0.7)" font-size="13">${escapeXml(o.title)}</text>`,
    ...yGrid,
    ...xGrid,
    `<rect x="${pad.l}" y="${pad.t}" width="${innerW}" height="${innerH}" fill="none" stroke="rgba(255,255,255,0.1)"/>`,
    `<path d="${path}" fill="none" stroke="#00f6d2" stroke-width="2"/>`,
    `</svg>`,
  ].join('');
}

function notFoundSvg(W: number, H: number, msg: string): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="sans-serif" font-size="11">`,
    `<rect width="${W}" height="${H}" fill="#042548"/>`,
    `<text x="${(W / 2).toFixed(1)}" y="${(H / 2).toFixed(1)}" text-anchor="middle" fill="#fff" font-size="22">${escapeXml(msg)}</text>`,
    `</svg>`,
  ].join('');
}

/** Explicit font config so resvg works inside the slim node:22-alpine image —
 *  the Dockerfile installs `ttf-dejavu`, and resvg picks up "DejaVu Sans" as
 *  the default when our SVG asks for `font-family="sans-serif"`. Without this
 *  text glyphs render as empty boxes (or nothing). */
function svgToPng(svg: string, width: number): Buffer {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    font: {
      loadSystemFonts: true,
      fontDirs: ['/usr/share/fonts'],
      defaultFontFamily: 'DejaVu Sans',
    },
  });
  return resvg.render().asPng();
}

interface SymRow { aid: string; short_name: string | null; unit_name: string | null; name: string | null }

async function loadSymbols(aid1: number, aid2: number): Promise<Map<number, SymRow>> {
  const { rows } = await q<SymRow>(
    `SELECT aid::text, short_name, unit_name, name FROM assets WHERE aid = ANY($1::bigint[])`,
    [[aid1, aid2]],
  );
  const m = new Map<number, SymRow>();
  for (const r of rows) m.set(Number(r.aid), r);
  return m;
}

export async function pairChartRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>('/pair/:id/chart.png', async (req, reply) => {
    const parsed = Query.safeParse(req.query);
    if (!parsed.success) {
      throw BadRequest('BAD_REQUEST', parsed.error.issues[0]?.message ?? 'invalid query');
    }
    const { days, w: width, h: height } = parsed.data;

    const resolved = await resolvePair(req.params.id);
    if (resolved === null) {
      void reply.header('content-type', 'image/png');
      void reply.header('cache-control', 'public, max-age=60');
      void reply.status(404);
      return reply.send(svgToPng(notFoundSvg(width, height, 'Pair not found'), width));
    }

    const { interval, limit } = rangeToCandles(days);
    const [rawCandles, syms] = await Promise.all([
      fetchCandles({ pair: resolved, interval, limit, denom: 'usd' }),
      loadSymbols(resolved.aid1, resolved.aid2),
    ]);

    // Forward-fill no-trade buckets so the line steps flat across gaps, matching
    // the web chart instead of drawing a diagonal interpolation between trades.
    const candles = densifyCandles(rawCandles, INTERVALS[interval].seconds);
    const series = candles.map((c) => ({ t: c.time, v: c.close }));
    const sym1 = syms.get(resolved.aid1)?.short_name ?? `aid${resolved.aid1}`;
    const sym2 = syms.get(resolved.aid2)?.short_name ?? `aid${resolved.aid2}`;
    const tokenName = syms.get(resolved.aid2)?.name ?? syms.get(resolved.aid2)?.unit_name ?? sym2;

    const rangeLabel = days === 'all'
      ? 'All-time'
      : days === 1
        ? '24h'
        : `${days}d`;
    const title = `${tokenName} (${sym2} / ${sym1}) · ${rangeLabel}`;

    const svg = renderChartSvg({ series, title, width, height });
    void reply.header('content-type', 'image/png');
    void reply.header('cache-control', 'public, max-age=60');
    return reply.send(svgToPng(svg, width));
  });
}
