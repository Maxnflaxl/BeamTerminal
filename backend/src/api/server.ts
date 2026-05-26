import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { installErrorHandler } from './error.js';
import { healthRoutes } from './routes/health.js';
import { statsRoutes } from './routes/stats.js';
import { pairsRoutes } from './routes/pairs.js';
import { ohlcvRoutes } from './routes/ohlcv.js';
import { tradesRoutes } from './routes/trades.js';
import { assetRoutes } from './routes/asset.js';
import { chartsRoutes, startChartCacheRefresher } from './routes/charts.js';
import { cgTickersRoutes } from './routes/cg/tickers.js';
import { cgHistoricalTradesRoutes } from './routes/cg/historical_trades.js';

export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: false, // we use pino directly in routes
    disableRequestLogging: true,
    trustProxy: true,
  });

  // Minimal CORS — open by default (matches Decision #16 in docs/README.md).
  app.addHook('onSend', async (_req, reply) => {
    void reply.header('access-control-allow-origin', '*');
    void reply.header('access-control-allow-methods', 'GET, OPTIONS');
    void reply.header('access-control-allow-headers', '*');
  });
  app.options('/*', async (_req, reply) => reply.status(204).send());

  app.addHook('onResponse', async (req, reply) => {
    if (req.url === '/api/health') return; // too chatty
    logger.debug(
      { method: req.method, url: req.url, status: reply.statusCode, ms: reply.elapsedTime },
      'http',
    );
  });

  installErrorHandler(app);

  if (config.RATE_LIMIT_PER_MIN > 0) {
    // Note: /api/health is rate-limited along with everything else. At 600/min
    // there's plenty of headroom for any sane uptime probe; if a probe is
    // legitimately hitting >10/sec, tune RATE_LIMIT_PER_MIN.
    void app.register(rateLimit, {
      max: config.RATE_LIMIT_PER_MIN,
      timeWindow: '1 minute',
      errorResponseBuilder: (_req, ctx) => ({
        error: {
          code: 'RATE_LIMITED',
          message: `rate limit ${ctx.max}/min exceeded; retry in ${ctx.after}`,
        },
      }),
    });
  }

  void app.register(healthRoutes, { prefix: '/api' });
  void app.register(statsRoutes, { prefix: '/api' });
  void app.register(pairsRoutes, { prefix: '/api' });
  void app.register(ohlcvRoutes, { prefix: '/api' });
  void app.register(tradesRoutes, { prefix: '/api' });
  void app.register(assetRoutes, { prefix: '/api' });
  void app.register(chartsRoutes, { prefix: '/api' });

  void app.register(cgTickersRoutes, { prefix: '/cg' });
  void app.register(cgHistoricalTradesRoutes, { prefix: '/cg' });

  return app;
}

export async function startApi(): Promise<FastifyInstance> {
  const app = buildApp();
  await app.listen({ host: config.API_HOST, port: config.API_PORT });
  logger.info({ host: config.API_HOST, port: config.API_PORT }, 'api listening');
  startChartCacheRefresher();
  return app;
}
