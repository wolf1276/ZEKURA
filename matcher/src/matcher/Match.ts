import type { Asset } from '../types/Asset.js';
import type { Hex32 } from '../types/Asset.js';

/**
 * A single matched buy/sell pair, ready to be settled. `price`/`amount` are
 * the values the settlement will be validated against — per the contract's
 * settle(), a valid match always has equal amount and buy.price >= sell.price;
 * the crossing price recorded here is the resting (maker) order's price,
 * i.e. the price the contract will actually see re-derived from both
 * orders' own disclosed OrderDetails (settle() does not take a price
 * argument — this field is for the Matcher's own bookkeeping/API responses).
 */
export interface Match {
  readonly id: Hex32;
  readonly buyOrderId: Hex32;
  readonly sellOrderId: Hex32;
  readonly asset: Asset;
  readonly price: bigint;
  readonly amount: bigint;
  readonly matchedAt: number;
}
