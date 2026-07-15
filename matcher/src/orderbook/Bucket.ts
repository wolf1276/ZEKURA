import type { Side } from '../types/Side.js';

interface PriceLevel {
  readonly price: bigint;
  /** FIFO by arrival — time priority within a price level. */
  readonly orderIds: string[];
}

/**
 * One side (BUY or SELL) of one asset's order book: a sorted array of price
 * levels ("best" price first for this side) each holding a FIFO queue of
 * order ids. `iterateInPriorityOrder` yields ids lazily in best-price/
 * earliest-time order so a caller (MatchingStrategy) can stop at the first
 * hit without ever materializing or scanning the rest of the book — the
 * "return immediately after the first valid match" rule lives one layer up,
 * this class just guarantees the iteration order that makes "first" mean
 * "best".
 */
export class Bucket {
  private readonly levels: PriceLevel[] = [];
  private readonly priceByOrderId = new Map<string, bigint>();

  constructor(private readonly side: Side) {}

  get size(): number {
    return this.priceByOrderId.size;
  }

  isEmpty(): boolean {
    return this.priceByOrderId.size === 0;
  }

  has(orderId: string): boolean {
    return this.priceByOrderId.has(orderId);
  }

  /**
   * -1 if `a` is a strictly better price than `b` for this side (BUY: higher
   * is better; SELL: lower is better), 1 if worse, 0 if equal.
   */
  private compareBetter(a: bigint, b: bigint): number {
    if (a === b) return 0;
    if (this.side === 'BUY') return a > b ? -1 : 1;
    return a < b ? -1 : 1;
  }

  /** Index of the level at `price`, or `-(insertionIndex + 1)` if absent (Array.prototype.sort-style encoding). */
  private findLevelIndex(price: bigint): number {
    let lo = 0;
    let hi = this.levels.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const cmp = this.compareBetter(this.levels[mid]!.price, price);
      if (cmp === 0) return mid;
      if (cmp < 0) lo = mid + 1;
      else hi = mid;
    }
    return -(lo + 1);
  }

  add(orderId: string, price: bigint): void {
    if (this.priceByOrderId.has(orderId)) {
      throw new Error(`Order ${orderId} is already present in this bucket`);
    }
    const idx = this.findLevelIndex(price);
    if (idx >= 0) {
      this.levels[idx]!.orderIds.push(orderId);
    } else {
      this.levels.splice(-(idx + 1), 0, { price, orderIds: [orderId] });
    }
    this.priceByOrderId.set(orderId, price);
  }

  remove(orderId: string): boolean {
    const price = this.priceByOrderId.get(orderId);
    if (price === undefined) return false;
    const idx = this.findLevelIndex(price);
    if (idx < 0) return false;
    const level = this.levels[idx]!;
    const pos = level.orderIds.indexOf(orderId);
    if (pos === -1) return false;
    level.orderIds.splice(pos, 1);
    if (level.orderIds.length === 0) this.levels.splice(idx, 1);
    this.priceByOrderId.delete(orderId);
    return true;
  }

  /** Best-price, then earliest-arrival order ids, yielded lazily. */
  *iterateInPriorityOrder(): IterableIterator<string> {
    for (const level of this.levels) {
      for (const id of level.orderIds) yield id;
    }
  }
}
