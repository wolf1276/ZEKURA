import { describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/app.js';
import type { OrderService, SubmitOrderResult, CancelOrderResult } from '../../src/services/OrderService.js';
import type { Order } from '../../src/types/Order.js';

function hexFill(byte: string): string {
  return byte.repeat(32);
}

function sampleOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: hexFill('01'),
    asset: { isLeft: true, left: hexFill('aa'), right: hexFill('00') },
    side: 'BUY',
    price: 1000n,
    amount: 50n,
    commitment: hexFill('cc'),
    ownerId: hexFill('bb'),
    signature: hexFill('dd'),
    status: 'OPEN',
    createdAt: 1_700_000_000_000,
    expiresAt: 9_999_999_999n,
    ...overrides,
  };
}

function validPayload() {
  const order = sampleOrder();
  return {
    id: order.id,
    asset: order.asset,
    side: order.side,
    price: order.price.toString(),
    amount: order.amount.toString(),
    commitment: order.commitment,
    ownerId: order.ownerId,
    signature: order.signature,
    expiresAt: order.expiresAt.toString(),
  };
}

function makeFakeOrderService(overrides: Partial<OrderService> = {}): OrderService {
  return {
    submitOrder: vi.fn(async (): Promise<SubmitOrderResult> => ({ ok: true, order: sampleOrder(), match: null })),
    cancelOrder: vi.fn((): CancelOrderResult => ({ ok: false, code: 'NOT_FOUND', message: 'no' })),
    getOrder: vi.fn(() => undefined),
    listOpen: vi.fn(() => []),
    ...overrides,
  } as unknown as OrderService;
}

function build(orderService: OrderService): FastifyInstance {
  return buildApp({ orderService, logger: false });
}

describe('POST /orders', () => {
  it('returns 201 with the created order and no match', async () => {
    const app = build(makeFakeOrderService());
    const res = await app.inject({ method: 'POST', url: '/orders', payload: validPayload() });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.order.id).toBe(hexFill('01'));
    expect(body.match).toBeNull();
    await app.close();
  });

  it('returns 400 for a malformed payload', async () => {
    const app = build(makeFakeOrderService());
    const res = await app.inject({ method: 'POST', url: '/orders', payload: { ...validPayload(), price: 'nope' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_failed');
    await app.close();
  });

  it('maps DUPLICATE to 409', async () => {
    const orderService = makeFakeOrderService({
      submitOrder: vi.fn(async () => ({ ok: false, code: 'DUPLICATE', message: 'dup' })) as unknown as OrderService['submitOrder'],
    });
    const app = build(orderService);
    const res = await app.inject({ method: 'POST', url: '/orders', payload: validPayload() });
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it('maps SIGNATURE_INVALID to 422', async () => {
    const orderService = makeFakeOrderService({
      submitOrder: vi.fn(async () => ({ ok: false, code: 'SIGNATURE_INVALID', message: 'bad sig' })) as unknown as OrderService['submitOrder'],
    });
    const app = build(orderService);
    const res = await app.inject({ method: 'POST', url: '/orders', payload: validPayload() });
    expect(res.statusCode).toBe(422);
    await app.close();
  });

  it('serializes bigint fields as decimal strings and includes match when present', async () => {
    const orderService = makeFakeOrderService({
      submitOrder: vi.fn(async () => ({
        ok: true,
        order: sampleOrder(),
        match: { id: 'm1', buyOrderId: hexFill('01'), sellOrderId: hexFill('02'), asset: sampleOrder().asset, price: 900n, amount: 50n, matchedAt: 1 },
      })) as unknown as OrderService['submitOrder'],
    });
    const app = build(orderService);
    const res = await app.inject({ method: 'POST', url: '/orders', payload: validPayload() });
    const body = res.json();
    expect(body.order.price).toBe('1000');
    expect(body.match.price).toBe('900');
    await app.close();
  });
});

describe('DELETE /orders/:id', () => {
  it('returns 200 on success', async () => {
    const orderService = makeFakeOrderService({
      cancelOrder: vi.fn(() => ({ ok: true, order: sampleOrder({ status: 'CANCELLED' }) })) as unknown as OrderService['cancelOrder'],
    });
    const app = build(orderService);
    const res = await app.inject({ method: 'DELETE', url: `/orders/${hexFill('01')}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().order.status).toBe('CANCELLED');
    await app.close();
  });

  it('returns 404 for NOT_FOUND', async () => {
    const app = build(makeFakeOrderService());
    const res = await app.inject({ method: 'DELETE', url: `/orders/${hexFill('01')}` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('returns 400 for a malformed id param', async () => {
    const app = build(makeFakeOrderService());
    const res = await app.inject({ method: 'DELETE', url: '/orders/not-a-valid-id' });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 409 for NOT_CANCELLABLE', async () => {
    const orderService = makeFakeOrderService({
      cancelOrder: vi.fn(() => ({ ok: false, code: 'NOT_CANCELLABLE', message: 'nope' })) as unknown as OrderService['cancelOrder'],
    });
    const app = build(orderService);
    const res = await app.inject({ method: 'DELETE', url: `/orders/${hexFill('01')}` });
    expect(res.statusCode).toBe(409);
    await app.close();
  });
});

describe('GET /orders/:id', () => {
  it('returns 200 with the order when found', async () => {
    const orderService = makeFakeOrderService({ getOrder: vi.fn(() => sampleOrder()) as unknown as OrderService['getOrder'] });
    const app = build(orderService);
    const res = await app.inject({ method: 'GET', url: `/orders/${hexFill('01')}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().order.id).toBe(hexFill('01'));
    await app.close();
  });

  it('returns 404 when not found', async () => {
    const app = build(makeFakeOrderService());
    const res = await app.inject({ method: 'GET', url: `/orders/${hexFill('01')}` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('returns 400 for a malformed id', async () => {
    const app = build(makeFakeOrderService());
    const res = await app.inject({ method: 'GET', url: '/orders/bad-id' });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe('GET /orders/open', () => {
  it('returns the list of open orders serialized', async () => {
    const orderService = makeFakeOrderService({ listOpen: vi.fn(() => [sampleOrder(), sampleOrder({ id: hexFill('02') })]) as unknown as OrderService['listOpen'] });
    const app = build(orderService);
    const res = await app.inject({ method: 'GET', url: '/orders/open' });
    expect(res.statusCode).toBe(200);
    expect(res.json().orders).toHaveLength(2);
    await app.close();
  });
});

describe('unmatched routes and errors', () => {
  it('returns a structured 404 for unknown routes', async () => {
    const app = build(makeFakeOrderService());
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('NOT_FOUND');
    await app.close();
  });

  it('returns a structured 500 when a handler throws unexpectedly', async () => {
    const orderService = makeFakeOrderService({
      getOrder: vi.fn(() => {
        throw new Error('boom');
      }) as unknown as OrderService['getOrder'],
    });
    const app = build(orderService);
    const res = await app.inject({ method: 'GET', url: `/orders/${hexFill('01')}` });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe('INTERNAL_ERROR');
    await app.close();
  });
});
