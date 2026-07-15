import type { Server as HttpServer } from 'node:http';

import { WebSocketServer, type WebSocket } from 'ws';

import type { Logger } from '../utils/logger.js';

export type MatcherEventType =
  | 'order.created'
  | 'order.cancelled'
  | 'order.matched'
  | 'order.settling'
  | 'order.filled'
  | 'order.expired'
  | 'order.failed';

export interface MatcherEvent<T = unknown> {
  readonly type: MatcherEventType;
  readonly payload: T;
  readonly timestamp: number;
}

/** What consumers (services/OrderService.ts, services/SettlementService.ts) need — never the full SocketServer, so tests can inject a bare spy. */
export interface Broadcaster {
  broadcast<T>(type: MatcherEventType, payload: T): void;
}

/** JSON.stringify replacer — Order/Match payloads carry bigint fields (price/amount/expiresAt) that JSON can't serialize natively. */
function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

/**
 * Broadcasts the 7 order lifecycle events over `ws`, attached to the same
 * HTTP server Fastify is already listening on (see src/app.ts) rather than
 * a second port.
 */
export class SocketServer {
  private readonly wss: WebSocketServer;
  private readonly clients = new Set<WebSocket>();
  private closed = false;

  constructor(server: HttpServer, private readonly logger: Logger, path = '/ws') {
    this.wss = new WebSocketServer({ server, path });
    this.wss.on('connection', (socket) => {
      this.clients.add(socket);
      this.logger.debug({ clientCount: this.clients.size }, 'websocket client connected');
      socket.on('close', () => {
        this.clients.delete(socket);
        this.logger.debug({ clientCount: this.clients.size }, 'websocket client disconnected');
      });
      socket.on('error', (error) => this.logger.warn({ error }, 'websocket client error'));
    });
  }

  broadcast<T>(type: MatcherEventType, payload: T): void {
    const event: MatcherEvent<T> = { type, payload, timestamp: Date.now() };
    const message = JSON.stringify(event, jsonReplacer);
    for (const client of this.clients) {
      if (client.readyState === client.OPEN) {
        client.send(message);
      }
    }
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** Idempotent — safe to call from multiple shutdown paths (e.g. a signal handler racing an explicit close). */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const client of this.clients) client.terminate();
    this.clients.clear();
    await new Promise<void>((resolve, reject) => {
      this.wss.close((error) => (error ? reject(error) : resolve()));
    });
  }
}
