import type { Asset } from '../types/Asset.js';
import type { Order } from '../types/Order.js';
import type { Side } from '../types/Side.js';

/** One aggregated price level in a snapshot — `amount` is the sum of every resting order's amount at `price`, not a single order. */
export interface OrderBookLevel {
  readonly price: bigint;
  readonly amount: bigint;
  readonly orderCount: number;
}

export interface OrderBookSnapshot {
  readonly asset: Asset;
  /** Best (highest) price first. */
  readonly bids: readonly OrderBookLevel[];
  /** Best (lowest) price first. */
  readonly asks: readonly OrderBookLevel[];
}

/**
 * -1 if `a` is a strictly better price than `b` for `side` (BUY: higher is
 * better; SELL: lower is better), 1 if worse, 0 if equal — the exact
 * ordering orderbook/Bucket.ts uses internally, so a REST snapshot always
 * agrees with the matching engine's own view of "best price".
 */
function compareBetter(side: Side, a: bigint, b: bigint): number {
  if (a === b) return 0;
  if (side === 'BUY') return a > b ? -1 : 1;
  return a < b ? -1 : 1;
}

function aggregateSide(orders: readonly Order[], side: Side): OrderBookLevel[] {
  const bySide = new Map<bigint, { amount: bigint; count: number }>();
  for (const order of orders) {
    if (order.side !== side) continue;
    const existing = bySide.get(order.price);
    if (existing) {
      existing.amount += order.amount;
      existing.count += 1;
    } else {
      bySide.set(order.price, { amount: order.amount, count: 1 });
    }
  }
  return [...bySide.entries()]
    .sort(([a], [b]) => compareBetter(side, a, b))
    .map(([price, { amount, count }]) => ({ price, amount, orderCount: count }));
}

/** Pure aggregation — takes the caller's own OPEN orders for one asset (see services/OrderService.ts, which sources them from the same lazy-expiry-checked read path GET /orders/open uses) and buckets them by price/side, exactly like orderbook/Bucket.ts does internally. */
export function buildOrderBookSnapshot(asset: Asset, openOrders: readonly Order[]): OrderBookSnapshot {
  return {
    asset,
    bids: aggregateSide(openOrders, 'BUY'),
    asks: aggregateSide(openOrders, 'SELL'),
  };
}
