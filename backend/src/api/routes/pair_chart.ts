import type { FastifyInstance } from 'fastify';
import { Resvg } from '@resvg/resvg-js';
import { z } from 'zod';
import { q } from '../../db.js';
import { BadRequest } from '../error.js';
import { resolvePair } from '../repos/pairs.js';
import { fetchCandles, type Interval } from '../repos/ohlcv.js';

/**
 * GET /pair/:id/chart.png
 *
 * Server-rendered price chart for use in chat bots (Telegram /c, Discord /c).
 * Mirrors the dark palette of the frontend pair-detail page.
 *
 * Registered WITHOUT the /api prefix to match og.ts — image assets are CDN-
 * cacheable and easier for chat clients / OG crawlers to hotlink at a short
 * URL.
 */

const Query = z.object({
  days: z
    .union([z.literal('all'), z.coerce.number().int().positive().max(3650)])
    .default(1),
  w: z.coerce.number().int().min(200).max(2000).default(900),
  h: z.coerce.number().int().min(150).max(1200).default(500),
});

/** Maps a days spec onto the densest interval/limit pair that keeps the chart
 *  readable without hammering the DB. Mirrors the frontend's pair-detail chart
 *  granularity (5m for intraday, daily for the all-time view). */
function rangeToCandles(days: number | 'all'): { interval: Interval; limit: number } {
  if (days === 'all' || days > 365) return { interval: '1d', limit: 2000 };
  if (days <= 1) return { interval: '5m', limit: 288 };
  if (days <= 7) return { interval: '1h', limit: days * 24 };
  if (days <= 90) return { interval: '4h', limit: days * 6 };
  return { interval: '1d', limit: days };
}

function esc(s: string | null | undefined): string {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function fmtPrice(v: number | null): string {
  if (v === null || !Number.isFinite(v) || v <= 0) return '$0';
  if (v >= 1)   return '$' + v.toFixed(2);
  if (v >= 0.01)  return '$' + v.toFixed(4);
  if (v >= 1e-3)  return '$' + v.toFixed(5);
  if (v >= 1e-6)  return '$' + v.toFixed(8);
  // Scientific for ultra-small prices (e.g. $3.339E-8).
  return '$' + v.toExponential(3).replace('e', 'E');
}

function fmtAxisDate(epoch: number, days: number | 'all'): string {
  const d = new Date(epoch * 1000);
  if (days === 'all' || (typeof days === 'number' && days > 90)) {
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short' });
  }
  if (typeof days === 'number' && days <= 1) {
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

interface RenderOpts {
  title: string;
  /** Optional smaller subtitle line under the title (e.g. tier, denom). */
  subtitle?: string;
  closes: Array<{ t: number; v: number }>;
  width: number;
  height: number;
  days: number | 'all';
}

function renderChartSvg(o: RenderOpts): string {
  const W = o.width;
  const H = o.height;
  const padL = 56;
  const padR = 76;
  const padT = 72;
  const padB = 56;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  // Empty-state: no trades in the requested range. Still ships a real image so
  // the bot can attach it without special-casing the 200 response.
  if (o.closes.length < 2) {
    return shell(W, H,
      header(o.title, o.subtitle, padL),
      `<text x="${W / 2}" y="${H / 2}" fill="rgba(255,255,255,0.55)" text-anchor="middle" ` +
      `font-family="SF Pro Display,Helvetica,Arial,sans-serif" font-size="22">` +
      `No trades in range</text>`,
    );
  }

  const values = o.closes.map((c) => c.v);
  const tMin = o.closes[0]!.t;
  const tMax = o.closes[o.closes.length - 1]!.t;
  let vMin = Math.min(...values);
  let vMax = Math.max(...values);
  if (vMin === vMax) { vMin *= 0.99; vMax *= 1.01; }
  const padding = (vMax - vMin) * 0.08;
  vMin = Math.max(0, vMin - padding);
  vMax = vMax + padding;
  const vRange = Math.max(vMax - vMin, Number.EPSILON);
  const tRange = Math.max(tMax - tMin, 1);

  const xAt = (t: number) => padL + ((t - tMin) / tRange) * innerW;
  const yAt = (v: number) => padT + innerH - ((v - vMin) / vRange) * innerH;

  // Line path
  const linePath = o.closes
    .map((c, i) => (i === 0 ? 'M' : 'L') + xAt(c.t).toFixed(1) + ',' + yAt(c.v).toFixed(1))
    .join(' ');
  const fillPath = linePath +
    ` L${xAt(tMax).toFixed(1)},${(padT + innerH).toFixed(1)}` +
    ` L${xAt(tMin).toFixed(1)},${(padT + innerH).toFixed(1)} Z`;

  // Y-axis: 4 horizontal grid lines + USD labels (right-aligned to match the
  // user's reference screenshot).
  const yTicks: string[] = [];
  for (let i = 0; i <= 4; i++) {
    const v = vMin + (vRange * i) / 4;
    const y = yAt(v);
    yTicks.push(
      `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${(W - padR).toFixed(1)}" y2="${y.toFixed(1)}" stroke="rgba(255,255,255,0.07)" stroke-width="1"/>` +
      `<text x="${(W - padR + 8).toFixed(1)}" y="${(y + 4).toFixed(1)}" fill="rgba(255,255,255,0.55)" font-size="12" font-family="SF Pro Display,Helvetica,Arial,sans-serif">${esc(fmtPrice(v))}</text>`,
    );
  }

  // X-axis: 5 evenly spaced date labels.
  const xTicks: string[] = [];
  const xCount = 5;
  for (let i = 0; i < xCount; i++) {
    const t = tMin + (tRange * i) / (xCount - 1);
    const x = xAt(t);
    xTicks.push(
      `<text x="${x.toFixed(1)}" y="${(padT + innerH + 24).toFixed(1)}" fill="rgba(255,255,255,0.55)" font-size="12" font-family="SF Pro Display,Helvetica,Arial,sans-serif" text-anchor="middle">${esc(fmtAxisDate(t, o.days))}</text>`,
    );
  }

  // Axis baselines (Y at the right since labels are right-aligned, X at the bottom).
  const axes =
    `<line x1="${padL}" y1="${padT}" x2="${padL}" y2="${(padT + innerH).toFixed(1)}" stroke="rgba(255,255,255,0.25)" stroke-width="1"/>` +
    `<line x1="${padL}" y1="${(padT + innerH).toFixed(1)}" x2="${(W - padR).toFixed(1)}" y2="${(padT + innerH).toFixed(1)}" stroke="rgba(255,255,255,0.25)" stroke-width="1"/>`;

  return shell(W, H,
    header(o.title, o.subtitle, padL),
    yTicks.join(''),
    `<path d="${fillPath}" fill="url(#mint)"/>`,
    `<path d="${linePath}" fill="none" stroke="#00f6d2" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>`,
    axes,
    xTicks.join(''),
  );
}

function shell(W: number, H: number, ...inner: string[]): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    `<defs>`,
    `  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">`,
    `    <stop offset="0%" stop-color="#031b34"/>`,
    `    <stop offset="100%" stop-color="#042548"/>`,
    `  </linearGradient>`,
    `  <linearGradient id="mint" x1="0" y1="0" x2="0" y2="1">`,
    `    <stop offset="0%" stop-color="#00f6d2" stop-opacity="0.45"/>`,
    `    <stop offset="100%" stop-color="#00f6d2" stop-opacity="0"/>`,
    `  </linearGradient>`,
    `</defs>`,
    `<rect width="100%" height="100%" fill="url(#bg)"/>`,
    inner.join(''),
    `</svg>`,
  ].join('');
}

function header(title: string, subtitle: string | undefined, padL: number): string {
  return [
    `<g font-family="SF Pro Display,Helvetica,Arial,sans-serif">`,
    `  <text x="${padL}" y="36" fill="#ffffff" font-size="20" font-weight="700">${esc(title)}</text>`,
    subtitle
      ? `<text x="${padL}" y="56" fill="rgba(255,255,255,0.55)" font-size="13">${esc(subtitle)}</text>`
      : '',
    `</g>`,
  ].join('');
}

/** Smallest valid PNG (1x1 transparent) used when we can't produce a real image
 *  but still need to honor Content-Type for the 404 path. resvg can render the
 *  SVG "Pair not found" frame too; we use a real SVG so the response looks
 *  identical to a normal 200 page just sized down. */
function notFoundSvg(W: number, H: number, msg: string): string {
  return shell(W, H,
    `<text x="${W / 2}" y="${H / 2}" fill="#ffffff" text-anchor="middle" ` +
    `font-family="SF Pro Display,Helvetica,Arial,sans-serif" font-size="40">${esc(msg)}</text>`,
  );
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
      const svg = notFoundSvg(width, height, 'Pair not found');
      const png = new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render().asPng();
      void reply.header('content-type', 'image/png');
      void reply.header('cache-control', 'public, max-age=60');
      void reply.status(404);
      return reply.send(png);
    }

    const { interval, limit } = rangeToCandles(days);
    const [candles, syms] = await Promise.all([
      fetchCandles({ pair: resolved, interval, limit, denom: 'usd' }),
      loadSymbols(resolved.aid1, resolved.aid2),
    ]);

    const closes = candles.map((c) => ({ t: c.time, v: c.close }));
    const sym1 = syms.get(resolved.aid1)?.short_name ?? `aid${resolved.aid1}`;
    const sym2 = syms.get(resolved.aid2)?.short_name ?? `aid${resolved.aid2}`;
    const tokenName = syms.get(resolved.aid2)?.name ?? syms.get(resolved.aid2)?.unit_name ?? sym2;

    const rangeLabel = days === 'all'
      ? 'All-time'
      : days === 1
        ? 'Last 24h'
        : `Last ${days}d`;
    const title = `${tokenName} (${sym2} / ${sym1})`;
    const subtitle = `${rangeLabel} · USD`;

    const svg = renderChartSvg({ title, subtitle, closes, width, height, days });
    const png = new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render().asPng();

    void reply.header('content-type', 'image/png');
    void reply.header('cache-control', 'public, max-age=60');
    return reply.send(png);
  });
}
