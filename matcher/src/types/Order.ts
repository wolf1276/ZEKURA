import type { Asset, Hex32 } from './Asset.js';
import type { Side } from './Side.js';
import type { OrderStatus } from './Status.js';

/**
 * A fully disclosed order as the Matcher holds it. `commitment`/`ownerId`
 * mirror the two public/private-but-disclosed fields the contract's
 * `OrderDetails`+commitment scheme is built from; `signature` is the
 * order's blinding factor — see utils/orderDetailsCodec.ts for why that
 * doubles as this system's authentication proof instead of a bolted-on
 * digital signature scheme.
 */
export interface Order {
  readonly id: Hex32;
  readonly asset: Asset;
  readonly side: Side;
  /** Uint<128> on-chain — kept as bigint end-to-end to avoid precision loss. */
  readonly price: bigint;
  /** Uint<128> on-chain. */
  readonly amount: bigint;
  readonly commitment: Hex32;
  /** deriveOwnerId(ownerSecretKey()) output — never the secret itself. */
  readonly ownerId: Hex32;
  /** The order's blinding factor (Bytes<32>), disclosed for settlement. */
  readonly signature: Hex32;
  readonly status: OrderStatus;
  /** Matcher-local receipt time, unix ms. */
  readonly createdAt: number;
  /** Uint<64> on-chain, unix seconds — compared via the contract's blockTimeGte. */
  readonly expiresAt: bigint;
}

export function isExpired(order: Pick<Order, 'expiresAt'>, nowSeconds: bigint): boolean {
  return nowSeconds >= order.expiresAt;
}
