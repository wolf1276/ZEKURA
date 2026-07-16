import { describe, expect, it } from 'vitest';

import { DEFAULT_PRICING_CONFIG, PricingEngine, type PricingConfig } from '../../src/ppm/PricingEngine.js';
import type { TreasuryLiquidity } from '../../src/ppm/TreasuryClient.js';

const NOW = 1_700_000_000n;

function liquidity(balance: bigint, reserved: bigint): TreasuryLiquidity {
  return { balance, reserved, available: balance - reserved };
}

describe('PricingEngine.quote', () => {
  it('returns null when the Treasury has zero available liquidity — never fabricates a fill', () => {
    const engine = new PricingEngine();
    const quote = engine.quote({ side: 'BUY', amount: 100n, referencePrice: 1_000n }, liquidity(0n, 0n), NOW);
    expect(quote).toBeNull();
  });

  it('returns null when there is no reference price yet', () => {
    const engine = new PricingEngine();
    const quote = engine.quote({ side: 'BUY', amount: 100n, referencePrice: null }, liquidity(10_000n, 0n), NOW);
    expect(quote).toBeNull();
  });

  it('returns null when the requested amount exceeds available liquidity', () => {
    const engine = new PricingEngine();
    const quote = engine.quote({ side: 'BUY', amount: 10_000n, referencePrice: 1_000n }, liquidity(5_000n, 0n), NOW);
    expect(quote).toBeNull();
  });

  it('returns null when the requested amount exceeds the risk-limited max exposure, even though the Treasury technically has enough', () => {
    const config: PricingConfig = { ...DEFAULT_PRICING_CONFIG, maxExposureFraction: 0.1 };
    const engine = new PricingEngine(config);
    // available = 10_000, maxExposure = 10% = 1_000, requesting 2_000
    const quote = engine.quote({ side: 'BUY', amount: 2_000n, referencePrice: 1_000n }, liquidity(10_000n, 0n), NOW);
    expect(quote).toBeNull();
  });

  it('never produces a partial fill — either the exact requested amount or no quote at all', () => {
    const engine = new PricingEngine();
    const quote = engine.quote({ side: 'BUY', amount: 500n, referencePrice: 1_000n }, liquidity(10_000n, 0n), NOW);
    expect(quote?.amount).toBe(500n);
  });

  it('quotes a BUY-side fill above the reference price (PPM sells, taker pays the spread)', () => {
    const config: PricingConfig = { ...DEFAULT_PRICING_CONFIG, baseSpreadBps: 100, inventorySkewBps: 0 };
    const engine = new PricingEngine(config);
    const quote = engine.quote({ side: 'BUY', amount: 100n, referencePrice: 1_000n }, liquidity(10_000n, 0n), NOW);
    expect(quote?.price).toBe(1_010n); // 1_000 + 1% of 1_000
  });

  it('quotes a SELL-side fill below the reference price (PPM buys, taker sells at a discount)', () => {
    const config: PricingConfig = { ...DEFAULT_PRICING_CONFIG, baseSpreadBps: 100, inventorySkewBps: 0 };
    const engine = new PricingEngine(config);
    const quote = engine.quote({ side: 'SELL', amount: 100n, referencePrice: 1_000n }, liquidity(10_000n, 0n), NOW);
    expect(quote?.price).toBe(990n); // 1_000 - 1% of 1_000
  });

  it('widens the spread as inventory utilization rises', () => {
    const config: PricingConfig = { ...DEFAULT_PRICING_CONFIG, baseSpreadBps: 100, inventorySkewBps: 400 };
    const engine = new PricingEngine(config);

    const lowUtilization = engine.quote({ side: 'BUY', amount: 100n, referencePrice: 1_000n }, liquidity(10_000n, 0n), NOW);
    const highUtilization = engine.quote({ side: 'BUY', amount: 100n, referencePrice: 1_000n }, liquidity(10_000n, 9_000n), NOW);

    expect(lowUtilization?.price).toBe(1_010n); // base 1% only, 0% utilization
    expect(highUtilization?.price).toBeGreaterThan(lowUtilization!.price); // 90% utilization adds most of the 4% skew
  });

  it('sets expiresAt to now + quoteTtlSeconds', () => {
    const config: PricingConfig = { ...DEFAULT_PRICING_CONFIG, quoteTtlSeconds: 300n };
    const engine = new PricingEngine(config);
    const quote = engine.quote({ side: 'BUY', amount: 100n, referencePrice: 1_000n }, liquidity(10_000n, 0n), NOW);
    expect(quote?.expiresAt).toBe(NOW + 300n);
  });
});
