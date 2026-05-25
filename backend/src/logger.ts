import { pino } from 'pino';
import { config } from './config.js';

const isDev = config.NODE_ENV !== 'production';

export const logger = pino({
  level: config.LOG_LEVEL,
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
        },
      }
    : {}),
});
