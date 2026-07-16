import type { Side } from '../types/Side.js';
import type { TreasuryLiquidity } from './TreasuryClient.js';

/**
 * Spread-curve + inventory-skew pricing config. All spreads are in basis
 * points (1 bps = 0.01%) to stay integer/deterministic — no floats touch a
 * price or amount anywhere in this file.
 */
export interface PricingConfig {
  /** Baseline spread applied regardless of inventory, in bps. */
  readonly baseSpreadBps: number;
  /** Never quote past this fraction of currently-available liquidity in one reservation (0..1) — the risk limit that keeps one quote from claiming the whole Treasury. */
  readonly maxExposureFraction: number;
  /** Extra spread applied at 100% utilization (reserved == balance), scaled linearly down to 0 at 0% utilization — widens the spread as the Treasury's inventory gets more committed, discouraging further draw-down. */
  readonly inventorySkewBps: number;
  /** How long a quote's on-chain reservation stays valid before releaseExpiredLiquidity can reclaim it. */
  readonly quoteTtlSeconds: bigint;
}

export const DEFAULT_PRICING_CONFIG: PricingConfig = {
  baseSpreadBps: 50, // 0.50%
  maxExposureFraction: 0.2, // never more than 20% of available liquidity per quote
  inventorySkewBps: 200, // up to +2.00% additional spread as reserved approaches balance
  quoteTtlSeconds: 120n,
};

export interface QuoteRequest {
  /** The side of the resting user order the PPM would be filling — the PPM itself takes the opposite side. */
  readonly side: Side;
  /** Exact amount required — settleWithProtocol has no partial-fill support (same exact-match rule settle() itself enforces between two user orders), so a quote is only produced if the full amount can be covered within the risk limit. */
  readonly amount: bigint;
  /** From MarketDataService.referencePrice — null (no market data yet) always yields no quote, never a fabricated price. */
  readonly referencePrice: bigint | null;
}

export interface Quote {
  readonly side: Side;
  readonly price: bigint;
  readonly amount: bigint;
  /** Absolute unix seconds. */
  readonly expiresAt: bigint;
}

/**
 * Pure, no I/O — mirrors orderbook/ and matcher/'s own "no I/O" convention.
 * Never invents liquidity: returns null whenever the Treasury can't fully
 * cover the request within the configured risk limit, or there's no
 * reference price to quote from at all.
 */
export class PricingEngine {
  constructor(private readonly config: PricingConfig = DEFAULT_PRICING_CONFIG) {}

  quote(request: QuoteRequest, treasury: TreasuryLiquidity, nowSeconds: bigint): Quote | null {
    if (request.referencePrice === null || request.referencePrice <= 0n) return null;
    if (request.amount <= 0n) return null;
    if (treasury.available <= 0n) return null;
    if (request.amount > treasury.available) return null;

    const maxExposure = (treasury.available * BigInt(Math.floor(this.config.maxExposureFraction * 10_000))) / 10_000n;
    if (request.amount > maxExposure) return null;

    const utilizationBps = treasury.balance > 0n ? Number((treasury.reserved * 10_000n) / treasury.balance) : 0;
    const skewBps = Math.floor((utilizationBps / 10_000) * this.config.inventorySkewBps);
    const totalSpreadBps = BigInt(this.config.baseSpreadBps + skewBps);

    // Taker BUYs -> PPM sells -> PPM's price sits above reference (needs the
    // taker's own limit price to already be >= this for settleWithProtocol's
    // crossing check to pass — mirrors settle()'s buyPrice >= sellPrice).
    // Taker SELLs -> PPM buys -> PPM's price sits below reference.
    const price =
      request.side === 'BUY'
        ? request.referencePrice + (request.referencePrice * totalSpreadBps) / 10_000n
        : request.referencePrice - (request.referencePrice * totalSpreadBps) / 10_000n;
    if (price <= 0n) return null;

    return { side: request.side, price, amount: request.amount, expiresAt: nowSeconds + this.config.quoteTtlSeconds };
  }
}
