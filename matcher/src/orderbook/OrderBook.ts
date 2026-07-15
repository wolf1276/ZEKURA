import { assetKey } from '../types/Asset.js';
import type { Order } from '../types/Order.js';
import type { Side } from '../types/Side.js';
import { AssetBook } from './AssetBook.js';
import { Bucket } from './Bucket.js';

interface Location {
  readonly assetKey: string;
  readonly side: Side;
}

/**
 * In-memory order book: Map<assetKey, AssetBook>. Only ever touched by
 * MatchingEngine's synchronous handlers (see services/OrderService.ts) —
 * never scanned wholesale; every operation is either O(1) (add/has) or
 * bounded to a single asset's single bucket (remove/oppositeBucket).
 */
export class OrderBook {
  private readonly books = new Map<string, AssetBook>();
  private readonly locations = new Map<string, Location>();

  private getOrCreateBook(key: string): AssetBook {
    let book = this.books.get(key);
    if (!book) {
      book = new AssetBook();
      this.books.set(key, book);
    }
    return book;
  }

  add(order: Pick<Order, 'id' | 'asset' | 'side' | 'price'>): void {
    const key = assetKey(order.asset);
    const book = this.getOrCreateBook(key);
    book.bucketFor(order.side).add(order.id, order.price);
    this.locations.set(order.id, { assetKey: key, side: order.side });
  }

  remove(orderId: string): boolean {
    const loc = this.locations.get(orderId);
    if (!loc) return false;
    const book = this.books.get(loc.assetKey);
    if (!book) return false;
    const removed = book.bucketFor(loc.side).remove(orderId);
    if (removed) {
      this.locations.delete(orderId);
      if (book.isEmpty()) this.books.delete(loc.assetKey);
    }
    return removed;
  }

  has(orderId: string): boolean {
    return this.locations.has(orderId);
  }

  /** The bucket an incoming order of this asset/side should search for a counterparty in. Empty if the asset has no book yet. */
  oppositeBucket(order: Pick<Order, 'asset' | 'side'>): Bucket {
    const key = assetKey(order.asset);
    const book = this.books.get(key);
    if (!book) return new Bucket(order.side === 'BUY' ? 'SELL' : 'BUY');
    return book.oppositeBucketFor(order.side);
  }

  assetCount(): number {
    return this.books.size;
  }
}
