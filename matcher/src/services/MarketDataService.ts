import type { OrderBookSnapshot } from '../orderbook/snapshot.js';
import type { TreasuryClient, TreasuryLiquidity } from '../ppm/TreasuryClient.js';
import type { Asset } from '../types/Asset.js';
import type { MarketStats } from '../types/MarketStats.js';

/**
 * The single composed snapshot of "everything about one asset's market
 * right now" — orderbook, rolling stats, and Treasury liquidity. Every
 * consumer (the /market API route, PricingEngine, the Settings/Overview/
 * Treasury pages via that route) reads from here rather than independently
 * re-deriving pieces of it, so there is exactly one place that assembles
 * this shape.
 */
export interface MarketDataSnapshot {
  readonly asset: Asset;
  readonly orderBook: OrderBookSnapshot;
  readonly stats: MarketStats;
  readonly treasury: TreasuryLiquidity;
}

export interface MarketDataServiceDeps {
  /**
   * Bound to OrderService.getOrderBookSnapshot/getMarketStats in
   * src/index.ts — taken as plain functions rather than the whole
   * OrderService so construction order doesn't matter: OrderService itself
   * optionally depends on a PPMService, which depends on this
   * MarketDataService, which would otherwise depend right back on
   * OrderService. Same forward-reference idiom src/index.ts already uses
   * for its SettlementService/SocketServer cycle, just via a function
   * reference instead of a `let` closure.
   */
  readonly getOrderBookSnapshot: (asset: Asset) => OrderBookSnapshot;
  readonly getMarketStats: (asset: Asset, windowMs: number) => MarketStats;
  readonly treasuryClient: TreasuryClient;
}

export class MarketDataService {
  constructor(private readonly deps: MarketDataServiceDeps) {}

  async getSnapshot(asset: Asset, statsWindowMs: number): Promise<MarketDataSnapshot> {
    const orderBook = this.deps.getOrderBookSnapshot(asset);
    const stats = this.deps.getMarketStats(asset, statsWindowMs);
    // asset *is* the Treasury's on-chain assetKey now (see types/Asset.ts) —
    // no separate mapping needed.
    const treasury = await this.deps.treasuryClient.getLiquidity(asset);
    return { asset, orderBook, stats, treasury };
  }

  /**
   * A reference price for pricing/display purposes: the last trade price if
   * there's been one, else the orderbook mid *when both sides are present*,
   * else null. Deliberately does NOT fall back to a single one-sided best
   * price: the caller asking for a reference is very often the same order
   * that's already resting in the book on its own side (see
   * ppm/PPMService.ts, which adds the order to the book before consulting
   * this), so a one-sided fallback would let an order's own limit price
   * become "the market reference" it's then priced against — circular, and
   * for a PPM quote specifically, mathematically un-crossable (a spread
   * applied on top of the order's own price can never satisfy that same
   * order's own crossing check). No independent reference simply means no
   * quote — never a fabricated one derived from the thing being priced.
   */
  static referencePrice(snapshot: Pick<MarketDataSnapshot, 'stats' | 'orderBook'>): bigint | null {
    if (snapshot.stats.lastPrice !== null) return snapshot.stats.lastPrice;
    const bestBid = snapshot.orderBook.bids[0]?.price;
    const bestAsk = snapshot.orderBook.asks[0]?.price;
    if (bestBid !== undefined && bestAsk !== undefined) return (bestBid + bestAsk) / 2n;
    return null;
  }
}
