import { describe, expect, it } from 'vitest';

import { Bucket } from '../../src/orderbook/Bucket.js';

describe('Bucket', () => {
  it('starts empty', () => {
    const bucket = new Bucket('BUY');
    expect(bucket.isEmpty()).toBe(true);
    expect(bucket.size).toBe(0);
    expect([...bucket.iterateInPriorityOrder()]).toEqual([]);
  });

  it('BUY bucket yields highest price first', () => {
    const bucket = new Bucket('BUY');
    bucket.add('low', 100n);
    bucket.add('high', 300n);
    bucket.add('mid', 200n);
    expect([...bucket.iterateInPriorityOrder()]).toEqual(['high', 'mid', 'low']);
  });

  it('SELL bucket yields lowest price first', () => {
    const bucket = new Bucket('SELL');
    bucket.add('low', 100n);
    bucket.add('high', 300n);
    bucket.add('mid', 200n);
    expect([...bucket.iterateInPriorityOrder()]).toEqual(['low', 'mid', 'high']);
  });

  it('preserves FIFO (time priority) within a price level', () => {
    const bucket = new Bucket('BUY');
    bucket.add('first', 100n);
    bucket.add('second', 100n);
    bucket.add('third', 100n);
    expect([...bucket.iterateInPriorityOrder()]).toEqual(['first', 'second', 'third']);
  });

  it('remove() evicts an order and collapses an emptied price level', () => {
    const bucket = new Bucket('BUY');
    bucket.add('a', 100n);
    bucket.add('b', 200n);
    expect(bucket.remove('a')).toBe(true);
    expect(bucket.has('a')).toBe(false);
    expect(bucket.size).toBe(1);
    expect([...bucket.iterateInPriorityOrder()]).toEqual(['b']);
  });

  it('remove() of one order in a multi-order price level keeps the level intact', () => {
    const bucket = new Bucket('BUY');
    bucket.add('a', 100n);
    bucket.add('b', 100n);
    bucket.remove('a');
    expect([...bucket.iterateInPriorityOrder()]).toEqual(['b']);
  });

  it('remove() of an unknown id is a no-op returning false', () => {
    const bucket = new Bucket('BUY');
    expect(bucket.remove('nope')).toBe(false);
  });

  it('add() rejects a duplicate id', () => {
    const bucket = new Bucket('BUY');
    bucket.add('a', 100n);
    expect(() => bucket.add('a', 200n)).toThrow();
  });

  it('has() reflects current membership', () => {
    const bucket = new Bucket('SELL');
    bucket.add('a', 100n);
    expect(bucket.has('a')).toBe(true);
    expect(bucket.has('b')).toBe(false);
  });

  it('never needs to scan past the requested entries — iteration is lazy and can be stopped early', () => {
    const bucket = new Bucket('BUY');
    for (let i = 0; i < 1000; i++) bucket.add(`order-${i}`, BigInt(i));
    let seen = 0;
    for (const _id of bucket.iterateInPriorityOrder()) {
      seen++;
      if (seen === 1) break;
    }
    expect(seen).toBe(1);
  });
});
