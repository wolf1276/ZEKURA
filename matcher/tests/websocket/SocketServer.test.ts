import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { SocketServer } from '../../src/websocket/SocketServer.js';
import { createLogger } from '../../src/utils/logger.js';

const logger = createLogger('test', { level: 'silent' });

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') resolve(address.port);
    });
  });
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
}

function waitForMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve) => {
    ws.once('message', (data) => resolve(JSON.parse(data.toString())));
  });
}

describe('SocketServer', () => {
  let httpServer: Server;
  let socketServer: SocketServer;
  let port: number;

  beforeEach(async () => {
    httpServer = createServer();
    port = await listen(httpServer);
    socketServer = new SocketServer(httpServer, logger);
  });

  afterEach(async () => {
    await socketServer.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it('accepts client connections and tracks clientCount', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await waitForOpen(ws);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(socketServer.clientCount).toBe(1);
    ws.close();
  });

  it('broadcasts an event to all connected clients as JSON', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await waitForOpen(ws);
    const messagePromise = waitForMessage(ws);

    socketServer.broadcast('order.created', { id: 'abc', status: 'OPEN' });

    const received = (await messagePromise) as { type: string; payload: unknown; timestamp: number };
    expect(received.type).toBe('order.created');
    expect(received.payload).toEqual({ id: 'abc', status: 'OPEN' });
    expect(typeof received.timestamp).toBe('number');
    ws.close();
  });

  it('serializes bigint fields in the payload as strings (Order/Match carry price/amount/expiresAt)', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await waitForOpen(ws);
    const messagePromise = waitForMessage(ws);

    socketServer.broadcast('order.matched', { price: 123456789012345678901234567890n });

    const received = (await messagePromise) as { payload: { price: string } };
    expect(received.payload.price).toBe('123456789012345678901234567890');
    ws.close();
  });

  it('does not throw broadcasting with zero connected clients', () => {
    expect(() => socketServer.broadcast('order.cancelled', {})).not.toThrow();
  });

  it('close() terminates still-connected clients and shuts down cleanly', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await waitForOpen(ws);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(socketServer.clientCount).toBe(1);

    await socketServer.close();
    expect(socketServer.clientCount).toBe(0);
  });

  it('stops tracking a client after it disconnects', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await waitForOpen(ws);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(socketServer.clientCount).toBe(1);
    ws.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(socketServer.clientCount).toBe(0);
  });
});
