import { describe, expect, it } from 'vitest';

import { AssetBook } from '../../src/orderbook/AssetBook.js';

describe('AssetBook', () => {
  it('starts empty on both sides', () => {
    const book = new AssetBook();
    expect(book.isEmpty()).toBe(true);
  });

  it('bucketFor/oppositeBucketFor route to the correct side', () => {
    const book = new AssetBook();
    expect(book.bucketFor('BUY')).toBe(book.buy);
    expect(book.bucketFor('SELL')).toBe(book.sell);
    expect(book.oppositeBucketFor('BUY')).toBe(book.sell);
    expect(book.oppositeBucketFor('SELL')).toBe(book.buy);
  });

  it('isEmpty is false once either side has an order', () => {
    const book = new AssetBook();
    book.buy.add('a', 100n);
    expect(book.isEmpty()).toBe(false);
    book.buy.remove('a');
    book.sell.add('b', 100n);
    expect(book.isEmpty()).toBe(false);
  });
});
