import { startApi } from './api/server.js';
import { logger } from './logger.js';
import { shutdown as shutdownDb } from './db.js';
import { seedImposters } from './imposters.js';

let stopping = false;

async function main(): Promise<void> {
  await seedImposters();
  const app = await startApi();

  const onSignal = async (signal: NodeJS.Signals): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down api');
    try {
      await app.close();
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err }, 'fastify close failed');
    }
    try {
      await shutdownDb();
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err }, 'db shutdown failed');
    }
    process.exit(0);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}

main().catch((err) => {
  logger.fatal({ err: err instanceof Error ? err.message : err }, 'api fatal');
  process.exit(1);
});
