import { describe, expect, it } from 'vitest';

import { MatchingEngine } from '../../src/matcher/MatchingEngine.js';
import { PriceTimePriorityStrategy } from '../../src/matcher/MatchingStrategy.js';
import { OrderBook } from '../../src/orderbook/OrderBook.js';
import type { Order } from '../../src/types/Order.js';

const ASSET = { isLeft: true, left: 'a'.repeat(64), right: '0'.repeat(64) };

function order(overrides: Partial<Order>): Order {
  return {
    id: 'id',
    asset: ASSET,
    side: 'BUY',
    price: 100n,
    amount: 10n,
    commitment: 'c'.repeat(64),
    ownerId: 'owner',
    signature: 's'.repeat(64),
    status: 'OPEN',
    createdAt: Date.now(),
    expiresAt: 9_999n,
    ...overrides,
  };
}

describe('MatchingEngine', () => {
  it('returns null when the opposite bucket has nothing crossing', () => {
    const book = new OrderBook();
    const engine = new MatchingEngine(book, new PriceTimePriorityStrategy());
    const buy = order({ id: 'buy', side: 'BUY', price: 100n });
    expect(engine.onOrderArrived(buy, () => undefined, 0n)).toBeNull();
  });

  it('produces a Match with buy/sell correctly assigned regardless of which side arrived last', () => {
    const book = new OrderBook();
    const engine = new MatchingEngine(book, new PriceTimePriorityStrategy());

    const sell = order({ id: 'sell', side: 'SELL', price: 90n, amount: 5n, ownerId: 'seller' });
    book.add(sell);
    const byId = new Map<string, Order>([[sell.id, sell]]);

    const buy = order({ id: 'buy', side: 'BUY', price: 100n, amount: 5n, ownerId: 'buyer' });
    const match = engine.onOrderArrived(buy, (id) => byId.get(id), 0n);

    expect(match).not.toBeNull();
    expect(match?.buyOrderId).toBe('buy');
    expect(match?.sellOrderId).toBe('sell');
    expect(match?.asset).toEqual(ASSET);
    expect(match?.amount).toBe(5n);
    expect(match?.price).toBe(90n); // resting (maker/sell) price, per Match.ts convention
  });

  it('assigns buy/sell correctly when the incoming order is itself the SELL side', () => {
    const book = new OrderBook();
    const engine = new MatchingEngine(book, new PriceTimePriorityStrategy());

    const buy = order({ id: 'buy', side: 'BUY', price: 100n, amount: 5n, ownerId: 'buyer' });
    book.add(buy);
    const byId = new Map<string, Order>([[buy.id, buy]]);

    const sell = order({ id: 'sell', side: 'SELL', price: 90n, amount: 5n, ownerId: 'seller' });
    const match = engine.onOrderArrived(sell, (id) => byId.get(id), 0n);

    expect(match?.buyOrderId).toBe('buy');
    expect(match?.sellOrderId).toBe('sell');
  });

  it('only searches the matching asset — an order for a different asset never matches', () => {
    const book = new OrderBook();
    const engine = new MatchingEngine(book, new PriceTimePriorityStrategy());
    const otherAsset = { isLeft: true, left: 'b'.repeat(64), right: '0'.repeat(64) };

    const sell = order({ id: 'sell', side: 'SELL', price: 90n, asset: otherAsset, ownerId: 'seller' });
    book.add(sell);
    const byId = new Map<string, Order>([[sell.id, sell]]);

    const buy = order({ id: 'buy', side: 'BUY', price: 100n, asset: ASSET, ownerId: 'buyer' });
    expect(engine.onOrderArrived(buy, (id) => byId.get(id), 0n)).toBeNull();
  });
});
