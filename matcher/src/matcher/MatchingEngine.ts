import { randomUUID } from 'node:crypto';

import type { OrderBook } from '../orderbook/OrderBook.js';
import type { Order } from '../types/Order.js';
import type { Match } from './Match.js';
import type { MatchingStrategy, OrderLookup } from './MatchingStrategy.js';

/**
 * Orchestrates the order book + a MatchingStrategy. Has exactly one entry
 * point that can produce a new Match (`onOrderArrived`), called
 * synchronously by services/OrderService.ts right after a new order is
 * added to the book. There is no timer, no poll loop, and no other trigger
 * — order cancellation only removes book entries (services/OrderService.ts
 * calls OrderBook.remove directly) and can never itself create a new
 * crossing, so it does not go through this class.
 */
export class MatchingEngine {
  constructor(
    private readonly orderBook: OrderBook,
    private readonly strategy: MatchingStrategy,
  ) {}

  onOrderArrived(incoming: Order, lookup: OrderLookup, nowSeconds: bigint): Match | null {
    const opposite = this.orderBook.oppositeBucket(incoming);
    const counterparty = this.strategy.findMatch(incoming, opposite, lookup, nowSeconds);
    if (!counterparty) return null;

    const isIncomingBuy = incoming.side === 'BUY';
    const buyOrder = isIncomingBuy ? incoming : counterparty;
    const sellOrder = isIncomingBuy ? counterparty : incoming;

    return {
      id: randomUUID(),
      buyOrderId: buyOrder.id,
      sellOrderId: sellOrder.id,
      asset: incoming.asset,
      // Resting (maker) side's price — see Match.ts doc comment; settle()
      // itself derives no single execution price, this is bookkeeping only.
      price: sellOrder.price,
      amount: incoming.amount,
      matchedAt: Date.now(),
    };
  }
}
