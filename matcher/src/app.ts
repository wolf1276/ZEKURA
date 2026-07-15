import Fastify, { type FastifyInstance } from 'fastify';

import { registerHealthRoutes } from './api/health.js';
import { registerMarketRoutes } from './api/market.js';
import { registerOrderRoutes } from './api/orders.js';
import type { OrderService } from './services/OrderService.js';

export interface BuildAppOptions {
  readonly orderService: OrderService;
  /** Fastify's own request logger — a separate concern from utils/logger.ts's Logger, which the domain/service layer uses directly. */
  readonly logger?: boolean;
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? true });

  registerHealthRoutes(app);
  registerOrderRoutes(app, options.orderService);
  registerMarketRoutes(app, options.orderService);

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ error }, 'unhandled request error');
    reply.code(500).send({ error: 'INTERNAL_ERROR', message: 'An unexpected error occurred' });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ error: 'NOT_FOUND', message: `No route: ${request.method} ${request.url}` });
  });

  return app;
}
