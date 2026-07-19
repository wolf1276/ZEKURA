import { describe, expect, it } from 'vitest';

import { OrderBook } from '../../src/orderbook/OrderBook.js';

const ASSET_A = 'a'.repeat(64);
const ASSET_B = 'b'.repeat(64);

describe('OrderBook', () => {
  it('partitions orders by asset — never mixes two different assets in one bucket pair', () => {
    const book = new OrderBook();
    book.add({ id: 'a1', asset: ASSET_A, side: 'BUY', price: 100n });
    book.add({ id: 'b1', asset: ASSET_B, side: 'BUY', price: 100n });

    const opp = book.oppositeBucket({ asset: ASSET_A, side: 'SELL' });
    // a SELL incoming for ASSET_A must only ever see ASSET_A's BUY bucket
    expect([...opp.iterateInPriorityOrder()]).toEqual(['a1']);
    expect(book.assetCount()).toBe(2);
  });

  it('oppositeBucket returns an empty bucket for an asset with no book yet (BUY incoming)', () => {
    const book = new OrderBook();
    const opp = book.oppositeBucket({ asset: ASSET_A, side: 'BUY' });
    expect([...opp.iterateInPriorityOrder()]).toEqual([]);
  });

  it('oppositeBucket returns an empty bucket for an asset with no book yet (SELL incoming)', () => {
    const book = new OrderBook();
    const opp = book.oppositeBucket({ asset: ASSET_A, side: 'SELL' });
    expect([...opp.iterateInPriorityOrder()]).toEqual([]);
  });

  it('remove() evicts from the correct asset/side and frees the asset entry once empty', () => {
    const book = new OrderBook();
    book.add({ id: 'a1', asset: ASSET_A, side: 'BUY', price: 100n });
    expect(book.assetCount()).toBe(1);
    expect(book.remove('a1')).toBe(true);
    expect(book.has('a1')).toBe(false);
    expect(book.assetCount()).toBe(0);
  });

  it('remove() of an unknown id is a no-op', () => {
    const book = new OrderBook();
    expect(book.remove('nope')).toBe(false);
  });

  it('has() reflects current membership across assets', () => {
    const book = new OrderBook();
    book.add({ id: 'a1', asset: ASSET_A, side: 'SELL', price: 100n });
    expect(book.has('a1')).toBe(true);
    expect(book.has('b1')).toBe(false);
  });
});
