import { describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/app.js';
import type { OrderService } from '../../src/services/OrderService.js';
import type { MarketStats } from '../../src/types/MarketStats.js';

function hexFill(byte: string): string {
  return byte.repeat(32);
}

const ASSET = { isLeft: true, left: hexFill('aa'), right: hexFill('00') };

function assetQuery(overrides: Record<string, string> = {}) {
  return { isLeft: 'true', left: ASSET.left, right: ASSET.right, ...overrides };
}

function makeFakeOrderService(overrides: Partial<OrderService> = {}): OrderService {
  return {
    submitOrder: vi.fn(),
    cancelOrder: vi.fn(),
    getOrder: vi.fn(),
    listOpen: vi.fn(() => []),
    getOrderBookSnapshot: vi.fn(() => ({ asset: ASSET, bids: [], asks: [] })),
    listRecentTrades: vi.fn(() => []),
    getMarketStats: vi.fn(
      (): MarketStats => ({
        asset: ASSET,
        lastPrice: null,
        openPrice: null,
        high: null,
        low: null,
        volumeBase: 0n,
        tradeCount: 0,
        changePct: null,
      }),
    ),
    ...overrides,
  } as unknown as OrderService;
}

function build(orderService: OrderService): FastifyInstance {
  return buildApp({ orderService, logger: false });
}

describe('GET /orderbook', () => {
  it('returns the snapshot serialized, bigints as decimal strings', async () => {
    const orderService = makeFakeOrderService({
      getOrderBookSnapshot: vi.fn(() => ({
        asset: ASSET,
        bids: [{ price: 900n, amount: 15n, orderCount: 2 }],
        asks: [{ price: 1_200n, amount: 20n, orderCount: 1 }],
      })) as unknown as OrderService['getOrderBookSnapshot'],
    });
    const app = build(orderService);
    const res = await app.inject({ method: 'GET', url: `/orderbook?isLeft=true&left=${ASSET.left}&right=${ASSET.right}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.bids).toEqual([{ price: '900', amount: '15', orderCount: 2 }]);
    expect(body.asks).toEqual([{ price: '1200', amount: '20', orderCount: 1 }]);
    await app.close();
  });

  it('passes the parsed asset through to the service', async () => {
    const orderService = makeFakeOrderService();
    const app = build(orderService);
    await app.inject({ method: 'GET', url: `/orderbook?isLeft=false&left=${ASSET.left}&right=${ASSET.right}` });
    expect(orderService.getOrderBookSnapshot).toHaveBeenCalledWith({ isLeft: false, left: ASSET.left, right: ASSET.right });
    await app.close();
  });

  it('returns 400 for a malformed asset query', async () => {
    const app = build(makeFakeOrderService());
    const res = await app.inject({ method: 'GET', url: '/orderbook?isLeft=true&left=not-hex&right=' + ASSET.right });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_failed');
    await app.close();
  });
});

describe('GET /trades', () => {
  it('returns recent trades serialized', async () => {
    const orderService = makeFakeOrderService({
      listRecentTrades: vi.fn(() => [
        { id: 'm1', buyOrderId: hexFill('01'), sellOrderId: hexFill('02'), asset: ASSET, price: 1_000n, amount: 10n, matchedAt: 123 },
      ]) as unknown as OrderService['listRecentTrades'],
    });
    const app = build(orderService);
    const res = await app.inject({ method: 'GET', url: `/trades?${new URLSearchParams(assetQuery()).toString()}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.trades).toEqual([{ id: 'm1', asset: ASSET, price: '1000', amount: '10', matchedAt: 123 }]);
    await app.close();
  });

  it('defaults limit to 50 and forwards a custom limit', async () => {
    const orderService = makeFakeOrderService();
    const app = build(orderService);
    await app.inject({ method: 'GET', url: `/trades?${new URLSearchParams(assetQuery()).toString()}` });
    expect(orderService.listRecentTrades).toHaveBeenCalledWith(ASSET, 50);

    await app.inject({ method: 'GET', url: `/trades?${new URLSearchParams(assetQuery({ limit: '5' })).toString()}` });
    expect(orderService.listRecentTrades).toHaveBeenLastCalledWith(ASSET, 5);
    await app.close();
  });

  it('returns 400 for a limit outside the allowed range', async () => {
    const app = build(makeFakeOrderService());
    const res = await app.inject({ method: 'GET', url: `/trades?${new URLSearchParams(assetQuery({ limit: '5000' })).toString()}` });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe('GET /stats', () => {
  it('returns stats serialized, nulls preserved', async () => {
    const app = build(makeFakeOrderService());
    const res = await app.inject({ method: 'GET', url: `/stats?${new URLSearchParams(assetQuery()).toString()}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      asset: ASSET,
      lastPrice: null,
      openPrice: null,
      high: null,
      low: null,
      volumeBase: '0',
      tradeCount: 0,
      changePct: null,
    });
    await app.close();
  });

  it('defaults windowMs to 24h and forwards a custom window', async () => {
    const orderService = makeFakeOrderService();
    const app = build(orderService);
    await app.inject({ method: 'GET', url: `/stats?${new URLSearchParams(assetQuery()).toString()}` });
    expect(orderService.getMarketStats).toHaveBeenCalledWith(ASSET, 24 * 60 * 60 * 1000);

    await app.inject({ method: 'GET', url: `/stats?${new URLSearchParams(assetQuery({ windowMs: '60000' })).toString()}` });
    expect(orderService.getMarketStats).toHaveBeenLastCalledWith(ASSET, 60_000);
    await app.close();
  });

  it('serializes non-null numeric fields as decimal strings and keeps changePct a number', async () => {
    const orderService = makeFakeOrderService({
      getMarketStats: vi.fn(
        (): MarketStats => ({
          asset: ASSET,
          lastPrice: 1_100n,
          openPrice: 1_000n,
          high: 1_100n,
          low: 1_000n,
          volumeBase: 15n,
          tradeCount: 2,
          changePct: 10,
        }),
      ) as unknown as OrderService['getMarketStats'],
    });
    const app = build(orderService);
    const res = await app.inject({ method: 'GET', url: `/stats?${new URLSearchParams(assetQuery()).toString()}` });
    const body = res.json();
    expect(body.lastPrice).toBe('1100');
    expect(body.volumeBase).toBe('15');
    expect(body.changePct).toBe(10);
    await app.close();
  });
});
