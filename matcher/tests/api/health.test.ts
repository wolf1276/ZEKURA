import { describe, expect, it, vi } from 'vitest';

import { buildApp } from '../../src/app.js';
import type { OrderService } from '../../src/services/OrderService.js';

describe('GET /health', () => {
  it('returns ok status with uptime and timestamp', async () => {
    const fakeOrderService = {
      submitOrder: vi.fn(),
      cancelOrder: vi.fn(),
      getOrder: vi.fn(),
      listOpen: vi.fn(),
    } as unknown as OrderService;

    const app = buildApp({ orderService: fakeOrderService, logger: false });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(typeof body.uptimeSeconds).toBe('number');
    expect(typeof body.timestamp).toBe('string');
    await app.close();
  });
});
