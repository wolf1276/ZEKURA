import pino, { type Logger } from 'pino';

export type { Logger };

export interface CreateLoggerOptions {
  readonly level?: string;
  readonly pretty?: boolean;
}

/**
 * Structured logger factory. Used both as Fastify's request logger and
 * standalone (matching engine, settlement queue) so every code path — HTTP
 * or not — logs through the same structured sink instead of console.log.
 */
export function createLogger(name: string, options: CreateLoggerOptions = {}): Logger {
  const { level = 'info', pretty = false } = options;
  return pino({
    name,
    level,
    transport: pretty ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } : undefined,
  });
}
