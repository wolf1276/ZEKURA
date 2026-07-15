import type { Side } from '../types/Side.js';
import { Bucket } from './Bucket.js';

/** The BUY and SELL sides of the order book for a single asset. */
export class AssetBook {
  readonly buy = new Bucket('BUY');
  readonly sell = new Bucket('SELL');

  bucketFor(side: Side): Bucket {
    return side === 'BUY' ? this.buy : this.sell;
  }

  oppositeBucketFor(side: Side): Bucket {
    return side === 'BUY' ? this.sell : this.buy;
  }

  isEmpty(): boolean {
    return this.buy.isEmpty() && this.sell.isEmpty();
  }
}
