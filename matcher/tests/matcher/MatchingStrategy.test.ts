import { describe, expect, it } from 'vitest';

import { Bucket } from '../../src/orderbook/Bucket.js';
import { PriceTimePriorityStrategy } from '../../src/matcher/MatchingStrategy.js';
import type { Order } from '../../src/types/Order.js';

const ASSET = 'a'.repeat(64);
const NOW = 1_000n;

function order(overrides: Partial<Order>): Order {
  return {
    id: 'id',
    asset: ASSET,
    side: 'BUY',
    price: 100n,
    amount: 10n,
    commitment: 'c'.repeat(64),
    ownerId: 'owner-a',
    signature: 's'.repeat(64),
    status: 'OPEN',
    createdAt: Date.now(),
    expiresAt: 9_999n,
    ...overrides,
  };
}

function bucketOf(orders: Order[], side: Order['side']): { bucket: Bucket; lookup: (id: string) => Order | undefined } {
  const bucket = new Bucket(side);
  const byId = new Map(orders.map((o) => [o.id, o]));
  for (const o of orders) bucket.add(o.id, o.price);
  return { bucket, lookup: (id) => byId.get(id) };
}

describe('PriceTimePriorityStrategy', () => {
  const strategy = new PriceTimePriorityStrategy();

  it('matches a crossing BUY against the best (lowest-price) SELL', () => {
    const incoming = order({ id: 'buy', side: 'BUY', price: 120n, ownerId: 'buyer' });
    const sells = [
      order({ id: 's1', side: 'SELL', price: 110n, ownerId: 'seller-1' }),
      order({ id: 's2', side: 'SELL', price: 100n, ownerId: 'seller-2' }),
    ];
    const { bucket, lookup } = bucketOf(sells, 'SELL');
    const match = strategy.findMatch(incoming, bucket, lookup, NOW);
    expect(match?.id).toBe('s2'); // best (lowest) price wins
  });

  it('returns null when no candidate crosses (buy price too low)', () => {
    const incoming = order({ id: 'buy', side: 'BUY', price: 50n, ownerId: 'buyer' });
    const { bucket, lookup } = bucketOf([order({ id: 's1', side: 'SELL', price: 100n, ownerId: 'seller' })], 'SELL');
    expect(strategy.findMatch(incoming, bucket, lookup, NOW)).toBeNull();
  });

  it('crosses at exactly equal price (>= boundary, mirrors the contract)', () => {
    const incoming = order({ id: 'buy', side: 'BUY', price: 100n, ownerId: 'buyer' });
    const { bucket, lookup } = bucketOf([order({ id: 's1', side: 'SELL', price: 100n, ownerId: 'seller' })], 'SELL');
    expect(strategy.findMatch(incoming, bucket, lookup, NOW)?.id).toBe('s1');
  });

  it('skips a same-owner order (no self-trades) but still matches a later eligible one', () => {
    const incoming = order({ id: 'buy', side: 'BUY', price: 120n, ownerId: 'shared-owner' });
    const sells = [
      order({ id: 's1', side: 'SELL', price: 100n, ownerId: 'shared-owner' }), // best price, same owner
      order({ id: 's2', side: 'SELL', price: 110n, ownerId: 'other-owner' }),
    ];
    const { bucket, lookup } = bucketOf(sells, 'SELL');
    expect(strategy.findMatch(incoming, bucket, lookup, NOW)?.id).toBe('s2');
  });

  it('skips a non-OPEN candidate (already CANCELLED/FILLED)', () => {
    const incoming = order({ id: 'buy', side: 'BUY', price: 120n, ownerId: 'buyer' });
    const sells = [
      order({ id: 's1', side: 'SELL', price: 100n, ownerId: 'seller-1', status: 'CANCELLED' }),
      order({ id: 's2', side: 'SELL', price: 110n, ownerId: 'seller-2', status: 'OPEN' }),
    ];
    const { bucket, lookup } = bucketOf(sells, 'SELL');
    expect(strategy.findMatch(incoming, bucket, lookup, NOW)?.id).toBe('s2');
  });

  it('skips an expired candidate', () => {
    const incoming = order({ id: 'buy', side: 'BUY', price: 120n, ownerId: 'buyer' });
    const sells = [
      order({ id: 's1', side: 'SELL', price: 100n, ownerId: 'seller-1', expiresAt: 500n }), // expired at NOW=1000
      order({ id: 's2', side: 'SELL', price: 110n, ownerId: 'seller-2', expiresAt: 5000n }),
    ];
    const { bucket, lookup } = bucketOf(sells, 'SELL');
    expect(strategy.findMatch(incoming, bucket, lookup, NOW)?.id).toBe('s2');
  });

  it('skips a stale bucket entry whose order can no longer be looked up (defensive)', () => {
    const incoming = order({ id: 'buy', side: 'BUY', price: 120n, ownerId: 'buyer' });
    const sells = [order({ id: 's1', side: 'SELL', price: 100n, ownerId: 'seller-1' })];
    const { bucket } = bucketOf(sells, 'SELL');
    const missingLookup = () => undefined; // simulates a bucket entry whose backing order vanished
    expect(strategy.findMatch(incoming, bucket, missingLookup, NOW)).toBeNull();
  });

  it('skips a candidate whose amount does not match exactly (no partial fills)', () => {
    const incoming = order({ id: 'buy', side: 'BUY', price: 120n, amount: 10n, ownerId: 'buyer' });
    const sells = [
      order({ id: 's1', side: 'SELL', price: 100n, amount: 5n, ownerId: 'seller-1' }),
      order({ id: 's2', side: 'SELL', price: 110n, amount: 10n, ownerId: 'seller-2' }),
    ];
    const { bucket, lookup } = bucketOf(sells, 'SELL');
    expect(strategy.findMatch(incoming, bucket, lookup, NOW)?.id).toBe('s2');
  });

  it('respects time priority within a crossing price level (earliest arrival wins)', () => {
    const incoming = order({ id: 'buy', side: 'BUY', price: 120n, ownerId: 'buyer' });
    const sells = [
      order({ id: 'first', side: 'SELL', price: 100n, ownerId: 'seller-1' }),
      order({ id: 'second', side: 'SELL', price: 100n, ownerId: 'seller-2' }),
    ];
    const { bucket, lookup } = bucketOf(sells, 'SELL');
    expect(strategy.findMatch(incoming, bucket, lookup, NOW)?.id).toBe('first');
  });

  it('stops scanning once a price level fails to cross — never scans the whole book', () => {
    const incoming = order({ id: 'buy', side: 'BUY', price: 100n, ownerId: 'buyer' });
    const sells = [
      order({ id: 's1', side: 'SELL', price: 200n, ownerId: 'seller-1' }), // fails to cross
      order({ id: 's2', side: 'SELL', price: 300n, ownerId: 'seller-2' }), // would also fail — must not be visited
    ];
    const { bucket, lookup } = bucketOf(sells, 'SELL');
    let visited = 0;
    const countingLookup = (id: string) => {
      visited++;
      return lookup(id);
    };
    expect(strategy.findMatch(incoming, bucket, countingLookup, NOW)).toBeNull();
    expect(visited).toBe(1); // only the first (best, still non-crossing) level was inspected
  });

  it('SELL side works symmetrically against a BUY bucket', () => {
    const incoming = order({ id: 'sell', side: 'SELL', price: 100n, ownerId: 'seller' });
    const buys = [
      order({ id: 'b1', side: 'BUY', price: 90n, ownerId: 'buyer-1' }), // does not cross
      order({ id: 'b2', side: 'BUY', price: 110n, ownerId: 'buyer-2' }), // crosses, best
    ];
    const { bucket, lookup } = bucketOf(buys, 'BUY');
    expect(strategy.findMatch(incoming, bucket, lookup, NOW)?.id).toBe('b2');
  });
});
