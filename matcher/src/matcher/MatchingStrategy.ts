import type { Bucket } from '../orderbook/Bucket.js';
import { isExpired, type Order } from '../types/Order.js';

export type OrderLookup = (orderId: string) => Order | undefined;

export interface MatchingStrategy {
  /**
   * Searches only `oppositeBucket` (already scoped to `incoming`'s asset
   * and the opposite side) and returns the first eligible counterparty, or
   * null. Must never scan past the point where price crossing has
   * definitively failed.
   */
  findMatch(incoming: Order, oppositeBucket: Bucket, lookup: OrderLookup, nowSeconds: bigint): Order | null;
}

function crosses(incoming: Order, candidate: Order): boolean {
  const [buyOrder, sellOrder] = incoming.side === 'BUY' ? [incoming, candidate] : [candidate, incoming];
  return buyOrder.price >= sellOrder.price;
}

/**
 * Price-time priority: Bucket already yields candidates best-price-first,
 * then earliest-arrival-first within a price level, so "first eligible
 * candidate" is by construction "best available match" — no separate
 * ranking step is needed here, only the eligibility filter from the brief.
 */
export class PriceTimePriorityStrategy implements MatchingStrategy {
  findMatch(incoming: Order, oppositeBucket: Bucket, lookup: OrderLookup, nowSeconds: bigint): Order | null {
    for (const candidateId of oppositeBucket.iterateInPriorityOrder()) {
      const candidate = lookup(candidateId);
      if (!candidate) continue; // stale bucket entry — defensive, should not happen

      if (!crosses(incoming, candidate)) {
        // Bucket is sorted best-to-worst for its side; once crossing fails
        // at this price level, every remaining (worse) level fails too.
        break;
      }

      if (candidate.ownerId === incoming.ownerId) continue; // no self-trades
      if (candidate.status !== 'OPEN') continue;
      if (isExpired(candidate, nowSeconds)) continue;
      // The contract requires buy.amount == sell.amount exactly (no partial
      // fills) — a mismatch here would be accepted by the Matcher's own book
      // but rejected on-chain by settle(), so it must be filtered here too.
      if (candidate.amount !== incoming.amount) continue;

      return candidate;
    }
    return null;
  }
}
