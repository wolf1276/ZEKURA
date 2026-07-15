import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { OrderRepository } from '../../src/db/repositories/OrderRepository.js';
import { openDatabase } from '../../src/db/sqlite.js';
import type { Order } from '../../src/types/Order.js';

function hexFill(byte: string): string {
  return byte.repeat(32);
}

function sampleOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: hexFill('01'),
    asset: { isLeft: true, left: hexFill('aa'), right: hexFill('00') },
    side: 'BUY',
    price: 1_000n,
    amount: 500n,
    commitment: hexFill('cc'),
    ownerId: hexFill('bb'),
    signature: hexFill('dd'),
    status: 'OPEN',
    createdAt: 1_700_000_000_000,
    expiresAt: 9_999_999_999n,
    ...overrides,
  };
}

describe('OrderRepository', () => {
  let db: Database.Database;
  let repo: OrderRepository;

  beforeEach(() => {
    db = openDatabase(':memory:');
    repo = new OrderRepository(db);
  });

  it('inserts and reads back an order with bigint fields intact', () => {
    const order = sampleOrder({ price: 340282366920938463463374607431768211455n, expiresAt: 18446744073709551615n });
    repo.insert(order);
    const found = repo.findById(order.id);
    expect(found).toEqual(order);
  });

  it('rejects a duplicate id (SQLite PRIMARY KEY constraint)', () => {
    const order = sampleOrder();
    repo.insert(order);
    expect(() => repo.insert(order)).toThrow();
  });

  it('exists() reflects presence', () => {
    expect(repo.exists(hexFill('01'))).toBe(false);
    repo.insert(sampleOrder());
    expect(repo.exists(hexFill('01'))).toBe(true);
  });

  it('findById returns undefined for a missing id', () => {
    expect(repo.findById(hexFill('99'))).toBeUndefined();
  });

  it('listOpen returns only OPEN orders, oldest first', () => {
    repo.insert(sampleOrder({ id: hexFill('01'), createdAt: 200, status: 'OPEN' }));
    repo.insert(sampleOrder({ id: hexFill('02'), createdAt: 100, status: 'OPEN' }));
    repo.insert(sampleOrder({ id: hexFill('03'), createdAt: 150, status: 'CANCELLED' }));
    const open = repo.listOpen();
    expect(open.map((o) => o.id)).toEqual([hexFill('02'), hexFill('01')]);
  });

  it('listByStatus filters correctly', () => {
    repo.insert(sampleOrder({ id: hexFill('01'), status: 'FILLED' }));
    repo.insert(sampleOrder({ id: hexFill('02'), status: 'OPEN' }));
    expect(repo.listByStatus('FILLED').map((o) => o.id)).toEqual([hexFill('01')]);
  });

  describe('updateStatus (compare-and-swap)', () => {
    it('applies unconditionally when no expected statuses are given', () => {
      repo.insert(sampleOrder());
      expect(repo.updateStatus(hexFill('01'), 'CANCELLED')).toBe(true);
      expect(repo.findById(hexFill('01'))?.status).toBe('CANCELLED');
    });

    it('applies only when current status matches one of the expected statuses', () => {
      repo.insert(sampleOrder({ status: 'OPEN' }));
      expect(repo.updateStatus(hexFill('01'), 'MATCHED', ['OPEN'])).toBe(true);
      expect(repo.findById(hexFill('01'))?.status).toBe('MATCHED');
    });

    it('rejects the transition when current status does not match (prevents double-claim)', () => {
      repo.insert(sampleOrder({ status: 'MATCHED' }));
      expect(repo.updateStatus(hexFill('01'), 'MATCHED', ['OPEN'])).toBe(false);
      expect(repo.findById(hexFill('01'))?.status).toBe('MATCHED'); // unchanged
    });

    it('returns false for a nonexistent id', () => {
      expect(repo.updateStatus(hexFill('99'), 'CANCELLED')).toBe(false);
    });
  });

  it('delete removes the row', () => {
    repo.insert(sampleOrder());
    expect(repo.delete(hexFill('01'))).toBe(true);
    expect(repo.findById(hexFill('01'))).toBeUndefined();
    expect(repo.delete(hexFill('01'))).toBe(false);
  });
});
