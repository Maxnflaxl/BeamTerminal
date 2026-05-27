import type { FastifyInstance } from 'fastify';
import { listPairs, resolvePairId } from '../repos/pairs.js';
import { loadUsdTable } from '../repos/usd.js';
import { loadSparklines7d } from '../repos/sparklines.js';
import { q } from '../../db.js';
import { readDexStats } from '../../services/dexStats.js';

// Open Graph card dimensions (Twitter / Facebook spec). Most aggregators
// expect raster; we ship SVG which Telegram / Discord / Slack render
// directly. Twitter rejects SVG — for that we'd need a PNG step (resvg-js
// or sharp). Ship SVG first; upgrade later if Twitter previews matter.
const OG_WIDTH = 1200;
const OG_HEIGHT = 630;

function esc(s: string | null | undefined): string {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function fmt$(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '$—';
  if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'k';
  if (v >= 1)   return '$' + v.toFixed(2);
  if (v > 0)    return '$' + v.toPrecision(3);
  return '$0';
}

function fmtPct(v: number | null): { text: string; color: string } {
  if (v === null || !Number.isFinite(v)) return { text: '—', color: '#888' };
  const sign = v >= 0 ? '+' : '';
  return {
    text: sign + v.toFixed(2) + '%',
    color: v >= 0 ? '#00f6d2' : '#f25f5b',
  };
}

function sparklinePath(values: ReadonlyArray<number>, x: number, y: number, w: number, h: number): string {
  if (values.length < 2) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(max - min, Number.EPSILON);
  return values
    .map((v, i) => {
      const px = x + (i / (values.length - 1)) * w;
      const py = y + h - ((v - min) / range) * h;
      return (i === 0 ? 'M' : 'L') + px.toFixed(1) + ',' + py.toFixed(1);
    })
    .join(' ');
}

function renderShell(inner: string): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${OG_WIDTH}" height="${OG_HEIGHT}" viewBox="0 0 ${OG_WIDTH} ${OG_HEIGHT}">`,
    `<defs>`,
    `  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">`,
    `    <stop offset="0%" stop-color="#031b34"/>`,
    `    <stop offset="100%" stop-color="#042548"/>`,
    `  </linearGradient>`,
    `  <linearGradient id="mint" x1="0" y1="0" x2="0" y2="1">`,
    `    <stop offset="0%" stop-color="#00f6d2" stop-opacity="0.55"/>`,
    `    <stop offset="100%" stop-color="#00f6d2" stop-opacity="0"/>`,
    `  </linearGradient>`,
    `</defs>`,
    `<rect width="100%" height="100%" fill="url(#bg)"/>`,
    // Subtle grid backdrop.
    `<g stroke="rgba(255,255,255,0.04)" stroke-width="1">`,
    Array.from({ length: 12 }, (_, i) => `<line x1="0" y1="${i * 60}" x2="${OG_WIDTH}" y2="${i * 60}"/>`).join(''),
    `</g>`,
    // Brand strip.
    `<g font-family="SF Pro Display,Helvetica,Arial,sans-serif">`,
    `  <text x="60" y="76" fill="#00f6d2" font-weight="700" font-size="22" letter-spacing="2">BEAMTERMINAL</text>`,
    `  <text x="${OG_WIDTH - 60}" y="76" text-anchor="end" fill="rgba(255,255,255,0.45)" font-size="16">beamterminal.0xmx.net</text>`,
    `</g>`,
    inner,
    `</svg>`,
  ].join('');
}

async function renderPairCard(poolId: number): Promise<string> {
  const rows = await listPairs({
    sort_by: 'aid2',
    order: 'asc',
    limit: 500,
    offset: 0,
    include_imposters: true,
  });
  const row = rows.find((r) => Number(r.pool_id) === poolId);
  if (!row) return renderShell(`<text x="60" y="320" fill="#fff" font-size="48">Pair not found</text>`);

  const [usd, sparkMap] = await Promise.all([loadUsdTable(), loadSparklines7d([poolId])]);
  const aid1 = Number(row.aid1);
  const aid2 = Number(row.aid2);
  const sym1 = row.symbol1 ?? `aid${aid1}`;
  const sym2 = row.symbol2 ?? `aid${aid2}`;
  const decimals1 = row.decimals1;
  const decimals2 = row.decimals2;
  const r1 = row.reserve1 ? Number(row.reserve1) / 10 ** decimals1 : null;
  const r2 = row.reserve2 ? Number(row.reserve2) / 10 ** decimals2 : null;
  const lastPriceNative = row.last_price_native ? Number(row.last_price_native) : null;
  const priceNative = lastPriceNative ?? (r1 !== null && r2 !== null && r1 > 0 ? r2 / r1 : null);
  const usdPerAid1 = usd.perAid.get(aid1) ?? null;
  const usdPerAid2 = usd.perAid.get(aid2) ?? null;
  const priceUsd = usdPerAid2 ?? (
    priceNative !== null && usdPerAid1 !== null && priceNative > 0
      ? usdPerAid1 / priceNative
      : null
  );
  const r1Usd = r1 !== null && usdPerAid1 !== null ? r1 * usdPerAid1 : null;
  const r2Usd = r2 !== null && usdPerAid2 !== null ? r2 * usdPerAid2 : null;
  const tvlUsd = r1Usd !== null && r2Usd !== null ? r1Usd + r2Usd : null;
  const volumeAid1Human = row.volume_24h_aid1
    ? Number(row.volume_24h_aid1) / 10 ** decimals1
    : 0;
  const volumeUsd = usdPerAid1 !== null ? volumeAid1Human * usdPerAid1 : null;
  let priceChange24h: number | null = null;
  if (lastPriceNative !== null && row.price_24h_ago) {
    const prev = Number(row.price_24h_ago);
    if (prev > 0) priceChange24h = ((lastPriceNative - prev) / prev) * 100;
  }
  const chg = fmtPct(priceChange24h);
  const kindLabel = ['Low (0.05%)', 'Medium (0.30%)', 'High (1.00%)'][row.kind] ?? '';

  // Sparkline data: backend stores raw aid2-per-aid1 closes. The pair page
  // inverts these for display — do the same so the OG mirrors the UI.
  const raw = sparkMap.get(poolId) ?? [];
  const inverted = raw.map((v) => (v > 0 ? 1 / v : 0));

  const sparkX = 60;
  const sparkY = 380;
  const sparkW = OG_WIDTH - 120;
  const sparkH = 170;
  const linePath = sparklinePath(inverted, sparkX, sparkY, sparkW, sparkH);
  const fillPath = linePath ? `${linePath} L${sparkX + sparkW},${sparkY + sparkH} L${sparkX},${sparkY + sparkH} Z` : '';

  return renderShell([
    // Pair name + tier
    `<g font-family="SF Pro Display,Helvetica,Arial,sans-serif">`,
    `  <text x="60" y="160" fill="#fff" font-weight="700" font-size="64">${esc(sym1)}/${esc(sym2)}</text>`,
    `  <text x="60" y="200" fill="rgba(255,255,255,0.5)" font-size="20">Tier · ${esc(kindLabel)}</text>`,
    // Big price
    `  <text x="60" y="290" fill="#fff" font-weight="700" font-size="56">${esc(fmt$(priceUsd))}</text>`,
    `  <text x="60" y="330" fill="${chg.color}" font-size="26" font-weight="600">${esc(chg.text)} 24h</text>`,
    // Right-side mini KPIs
    `  <text x="${OG_WIDTH - 60}" y="200" text-anchor="end" fill="rgba(255,255,255,0.5)" font-size="18">LIQUIDITY</text>`,
    `  <text x="${OG_WIDTH - 60}" y="232" text-anchor="end" fill="#fff" font-size="32" font-weight="600">${esc(fmt$(tvlUsd))}</text>`,
    `  <text x="${OG_WIDTH - 60}" y="290" text-anchor="end" fill="rgba(255,255,255,0.5)" font-size="18">VOLUME 24H</text>`,
    `  <text x="${OG_WIDTH - 60}" y="322" text-anchor="end" fill="#fff" font-size="32" font-weight="600">${esc(fmt$(volumeUsd))}</text>`,
    `</g>`,
    // 7d sparkline
    fillPath ? `<path d="${fillPath}" fill="url(#mint)"/>` : '',
    linePath ? `<path d="${linePath}" fill="none" stroke="#00f6d2" stroke-width="3" stroke-linejoin="round"/>` : '',
    // Sparkline footer label
    `<text x="60" y="${sparkY + sparkH + 24}" fill="rgba(255,255,255,0.4)" font-family="SF Pro Display,Helvetica,Arial,sans-serif" font-size="14">7-day price · oldest → newest</text>`,
  ].join(''));
}

async function renderSiteCard(): Promise<string> {
  const [statsRes, cachedDex] = await Promise.all([
    q<{ beam_usd: string | null; total_tvl_usd: string | null; volume_24h_usd: string | null; total_pairs: string | null; total_trades: string | null }>(
      `SELECT
         (SELECT beam_usd::text FROM oracle_snapshots ORDER BY ts DESC LIMIT 1) AS beam_usd,
         (SELECT COUNT(*)::text FROM pools WHERE destroyed_at_height IS NULL) AS total_pairs,
         (SELECT COUNT(*)::text FROM trades WHERE confirmed = TRUE) AS total_trades,
         NULL::text AS total_tvl_usd,
         NULL::text AS volume_24h_usd`,
    ),
    readDexStats(),
  ]);
  const r = statsRes.rows[0];
  const beamUsd = r?.beam_usd ? Number(r.beam_usd) : null;
  const totalTrades = r?.total_trades ? Number(r.total_trades) : null;
  const totalPairs = r?.total_pairs ? Number(r.total_pairs) : null;
  const totalVolume = cachedDex.total_volume_usd;

  return renderShell([
    `<g font-family="SF Pro Display,Helvetica,Arial,sans-serif">`,
    `  <text x="60" y="180" fill="#fff" font-weight="700" font-size="72">Beam DEX &amp; Network</text>`,
    `  <text x="60" y="222" fill="rgba(255,255,255,0.55)" font-size="22">Open block explorer + AMM analytics</text>`,
    // KPI grid
    `  <text x="60"  y="340" fill="rgba(255,255,255,0.5)" font-size="18">BEAM / USD</text>`,
    `  <text x="60"  y="380" fill="#00f6d2" font-size="42" font-weight="700">${esc(beamUsd !== null ? '$' + beamUsd.toFixed(4) : '—')}</text>`,
    `  <text x="380" y="340" fill="rgba(255,255,255,0.5)" font-size="18">TOTAL DEX VOLUME</text>`,
    `  <text x="380" y="380" fill="#fff" font-size="42" font-weight="700">${esc(fmt$(totalVolume))}</text>`,
    `  <text x="60"  y="470" fill="rgba(255,255,255,0.5)" font-size="18">ACTIVE PAIRS</text>`,
    `  <text x="60"  y="510" fill="#fff" font-size="42" font-weight="700">${esc(totalPairs !== null ? totalPairs.toLocaleString('en-US') : '—')}</text>`,
    `  <text x="380" y="470" fill="rgba(255,255,255,0.5)" font-size="18">TOTAL TRADES</text>`,
    `  <text x="380" y="510" fill="#fff" font-size="42" font-weight="700">${esc(totalTrades !== null ? totalTrades.toLocaleString('en-US') : '—')}</text>`,
    `</g>`,
  ].join(''));
}

export async function ogRoutes(app: FastifyInstance): Promise<void> {
  app.get('/og/site.svg', async (_req, reply) => {
    const svg = await renderSiteCard();
    void reply.header('content-type', 'image/svg+xml; charset=utf-8');
    void reply.header('cache-control', 'public, max-age=300');
    return reply.send(svg);
  });

  app.get<{ Params: { id: string } }>('/og/pair/:id.svg', async (req, reply) => {
    const poolId = await resolvePairId(req.params.id);
    if (poolId === null) {
      void reply.header('content-type', 'image/svg+xml; charset=utf-8');
      void reply.status(404);
      return reply.send(renderShell(`<text x="60" y="320" fill="#fff" font-family="sans-serif" font-size="48">Pair not found</text>`));
    }
    const svg = await renderPairCard(poolId);
    void reply.header('content-type', 'image/svg+xml; charset=utf-8');
    void reply.header('cache-control', 'public, max-age=300');
    return reply.send(svg);
  });
}
