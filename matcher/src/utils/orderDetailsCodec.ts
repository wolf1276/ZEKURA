/**
 * Wire-encoding of the contract's private `OrderDetails` struct and the
 * `persistentCommit` recomputation used to authenticate order submissions.
 *
 * This is a direct port of the encoding built (and validated against the
 * compiled contract) in ../../tests/exchange.test.ts — same
 * @midnight-ntwrk/compact-runtime primitives, same field order/types. It
 * must stay byte-for-byte identical to the contract's `OrderDetails`
 * struct layout (contracts/exchange.compact) or commitments computed here
 * will never match on-chain commitments computed by a real wallet.
 *
 * Why this exists (see ARCHITECTURE.md's security model): the contract's
 * only authentication primitive is `persistentCommit<OrderDetails>(details,
 * blinding) == commitment` — a hash preimage proof. A party can only
 * produce a `(details, blinding)` pair that recomputes to a given on-chain
 * commitment if it is the party that originally created it, so the
 * Matcher's Order.signature field is defined to be that blinding factor,
 * and "verifying the signature" means recomputing this commitment and
 * checking it against both the client-supplied commitment and the
 * commitment already recorded on-chain for that orderId. No separate
 * digital signature scheme is introduced.
 */
import * as rt from '@midnight-ntwrk/compact-runtime';

import type { Order } from '../types/Order.js';
import { bytes32ToHex, hexToBytes32 } from './hex.js';

export interface OrderDetailsValue {
  asset: Uint8Array;
  isBuy: boolean;
  price: bigint;
  amount: bigint;
  owner: { bytes: Uint8Array };
  expiresAt: bigint;
}

const Uint128Type = new rt.CompactTypeUnsignedInteger(340282366920938463463374607431768211455n, 16);
const Uint64Type = new rt.CompactTypeUnsignedInteger(18446744073709551615n, 8);

class OrderDetailsType implements rt.CompactType<OrderDetailsValue> {
  alignment() {
    return rt.Bytes32Descriptor
      .alignment()
      .concat(
        rt.CompactTypeBoolean.alignment().concat(
          Uint128Type.alignment().concat(
            Uint128Type.alignment().concat(rt.ZswapCoinPublicKeyDescriptor.alignment().concat(Uint64Type.alignment())),
          ),
        ),
      );
  }
  fromValue(value: rt.Value): OrderDetailsValue {
    return {
      asset: rt.Bytes32Descriptor.fromValue(value),
      isBuy: rt.CompactTypeBoolean.fromValue(value),
      price: Uint128Type.fromValue(value),
      amount: Uint128Type.fromValue(value),
      owner: rt.ZswapCoinPublicKeyDescriptor.fromValue(value),
      expiresAt: Uint64Type.fromValue(value),
    };
  }
  toValue(v: OrderDetailsValue) {
    return rt.Bytes32Descriptor.toValue(v.asset)
      .concat(
        rt.CompactTypeBoolean.toValue(v.isBuy).concat(
          Uint128Type.toValue(v.price).concat(
            Uint128Type.toValue(v.amount).concat(
              rt.ZswapCoinPublicKeyDescriptor.toValue(v.owner).concat(Uint64Type.toValue(v.expiresAt)),
            ),
          ),
        ),
      );
  }
}

export const orderDetailsType = new OrderDetailsType();

/** Builds the contract's wire-form OrderDetails from a Matcher Order. */
export function toOrderDetailsValue(order: Pick<Order, 'asset' | 'side' | 'price' | 'amount' | 'ownerId' | 'expiresAt'>): OrderDetailsValue {
  return {
    asset: hexToBytes32(order.asset),
    isBuy: order.side === 'BUY',
    price: order.price,
    amount: order.amount,
    owner: { bytes: hexToBytes32(order.ownerId) },
    expiresAt: order.expiresAt,
  };
}

/** Recomputes persistentCommit<OrderDetails>(details, blinding) as a hex32 string. */
export function computeCommitmentHex(details: OrderDetailsValue, blindingHex: string): string {
  const commitment = rt.persistentCommit(orderDetailsType, details, hexToBytes32(blindingHex));
  return bytes32ToHex(commitment);
}

/**
 * Recomputes the order's commitment from its own disclosed fields and
 * `signature` (blinding factor) and checks it equals `expectedCommitment`.
 * This is the entire authentication check — see module doc comment.
 */
export function verifyOrderSignature(
  order: Pick<Order, 'asset' | 'side' | 'price' | 'amount' | 'ownerId' | 'expiresAt' | 'signature'>,
  expectedCommitment: string,
): boolean {
  const recomputed = computeCommitmentHex(toOrderDetailsValue(order), order.signature);
  return recomputed === expectedCommitment;
}
