import { describe, expect, it } from 'vitest';

import { MarketDataService } from '../../src/services/MarketDataService.js';

describe('MarketDataService.referencePrice', () => {
  it('prefers lastPrice over everything else', () => {
    const price = MarketDataService.referencePrice({
      stats: { lastPrice: 500n } as never,
      orderBook: { bids: [{ price: 100n, amount: 1n }], asks: [{ price: 900n, amount: 1n }] } as never,
      bootstrapPrice: 1_000n,
    });
    expect(price).toBe(500n);
  });

  it('falls back to the two-sided book mid when there is no lastPrice', () => {
    const price = MarketDataService.referencePrice({
      stats: { lastPrice: null } as never,
      orderBook: { bids: [{ price: 100n, amount: 1n }], asks: [{ price: 300n, amount: 1n }] } as never,
      bootstrapPrice: 1_000n,
    });
    expect(price).toBe(200n);
  });

  it('falls back to the bootstrap price for a virgin asset (no lastPrice, one-sided or empty book)', () => {
    const price = MarketDataService.referencePrice({
      stats: { lastPrice: null } as never,
      orderBook: { bids: [], asks: [] } as never,
      bootstrapPrice: 750n,
    });
    expect(price).toBe(750n);
  });

  it('returns null when there is no lastPrice, no two-sided book, and no bootstrap price', () => {
    const price = MarketDataService.referencePrice({
      stats: { lastPrice: null } as never,
      orderBook: { bids: [], asks: [] } as never,
      bootstrapPrice: null,
    });
    expect(price).toBeNull();
  });
});
