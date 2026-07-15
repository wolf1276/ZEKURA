import { describe, expect, it } from 'vitest';

import { buildOrderBookSnapshot } from '../../src/orderbook/snapshot.js';
import type { Order } from '../../src/types/Order.js';

function hexFill(byte: string): string {
  return byte.repeat(32);
}

const ASSET = { isLeft: true, left: hexFill('aa'), right: hexFill('00') };

function sampleOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: hexFill('01'),
    asset: ASSET,
    side: 'BUY',
    price: 1_000n,
    amount: 500n,
    commitment: hexFill('cc'),
    ownerId: hexFill('bb'),
    signature: hexFill('dd'),
    status: 'OPEN',
    createdAt: Date.now(),
    expiresAt: 9_999_999_999n,
    ...overrides,
  };
}

describe('buildOrderBookSnapshot', () => {
  it('returns empty bids/asks for no orders', () => {
    const snapshot = buildOrderBookSnapshot(ASSET, []);
    expect(snapshot).toEqual({ asset: ASSET, bids: [], asks: [] });
  });

  it('aggregates orders at the same price into one level', () => {
    const orders = [
      sampleOrder({ id: hexFill('01'), side: 'BUY', price: 1_000n, amount: 100n }),
      sampleOrder({ id: hexFill('02'), side: 'BUY', price: 1_000n, amount: 250n }),
    ];
    const snapshot = buildOrderBookSnapshot(ASSET, orders);
    expect(snapshot.bids).toEqual([{ price: 1_000n, amount: 350n, orderCount: 2 }]);
    expect(snapshot.asks).toEqual([]);
  });

  it('sorts bids highest price first and asks lowest price first', () => {
    const orders = [
      sampleOrder({ id: hexFill('01'), side: 'BUY', price: 900n, amount: 10n }),
      sampleOrder({ id: hexFill('02'), side: 'BUY', price: 1_100n, amount: 10n }),
      sampleOrder({ id: hexFill('03'), side: 'SELL', price: 1_300n, amount: 10n }),
      sampleOrder({ id: hexFill('04'), side: 'SELL', price: 1_200n, amount: 10n }),
    ];
    const snapshot = buildOrderBookSnapshot(ASSET, orders);
    expect(snapshot.bids.map((l) => l.price)).toEqual([1_100n, 900n]);
    expect(snapshot.asks.map((l) => l.price)).toEqual([1_200n, 1_300n]);
  });

  it('keeps distinct prices as separate levels within a side', () => {
    const orders = [
      sampleOrder({ id: hexFill('01'), side: 'SELL', price: 1_200n, amount: 10n }),
      sampleOrder({ id: hexFill('02'), side: 'SELL', price: 1_250n, amount: 20n }),
    ];
    const snapshot = buildOrderBookSnapshot(ASSET, orders);
    expect(snapshot.asks).toEqual([
      { price: 1_200n, amount: 10n, orderCount: 1 },
      { price: 1_250n, amount: 20n, orderCount: 1 },
    ]);
  });
});
