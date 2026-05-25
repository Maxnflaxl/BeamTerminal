import type { FastifyInstance, FastifyReply, FastifyError } from 'fastify';
import { logger } from '../logger.js';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const NotFound = (code: string, message: string): ApiError =>
  new ApiError(404, code, message);
export const BadRequest = (code: string, message: string): ApiError =>
  new ApiError(400, code, message);

interface ErrorBody {
  error: { code: string; message: string };
}

function sendError(reply: FastifyReply, status: number, code: string, message: string): void {
  const body: ErrorBody = { error: { code, message } };
  void reply.status(status).send(body);
}

export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof ApiError) {
      sendError(reply, err.status, err.code, err.message);
      return;
    }
    if (err.validation) {
      sendError(
        reply,
        400,
        'BAD_REQUEST',
        err.message || 'invalid request',
      );
      return;
    }
    logger.error({ err: err.message, url: req.url }, 'unhandled error');
    sendError(reply, 500, 'INTERNAL_ERROR', 'internal error');
  });

  app.setNotFoundHandler((req, reply) => {
    sendError(reply, 404, 'NOT_FOUND', `no route for ${req.method} ${req.url}`);
  });
}
