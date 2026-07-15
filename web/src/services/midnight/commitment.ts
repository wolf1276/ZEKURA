/**
 * Off-chain commitment generation for contracts/exchange.compact's
 * `OrderDetails` struct — "the existing contract flow" the wallet must
 * reproduce exactly before calling `createOrder`, matching
 * `persistentCommit<OrderDetails>(details, blinding)` on-chain bit for bit.
 *
 * This is a direct port of the `OrderDetailsType`/`computeCommitment` runtime
 * codec already implemented and exercised in tests/exchange.test.ts (see
 * that file's header comment) — not a reinvention. `@midnight-ntwrk/compact-runtime`'s
 * public `CompactType` primitives are used exactly as declared in the
 * contract's struct layout: `asset: Either<Bytes32,Bytes32>`,
 * `isBuy: Boolean`, `price/amount: Uint<128>`, `owner: ZswapCoinPublicKey`,
 * `expiresAt: Uint<64>`.
 */
import * as rt from "@midnight-ntwrk/compact-runtime";

export interface OrderDetailsValue {
  asset: { is_left: boolean; left: Uint8Array; right: Uint8Array };
  isBuy: boolean;
  price: bigint;
  amount: bigint;
  owner: { bytes: Uint8Array };
  expiresAt: bigint;
}

const Uint128Type = new rt.CompactTypeUnsignedInteger(340282366920938463463374607431768211455n, 16);
const Uint64Type = new rt.CompactTypeUnsignedInteger(18446744073709551615n, 8);

class EitherBytes32Type
  implements rt.CompactType<{ is_left: boolean; left: Uint8Array; right: Uint8Array }>
{
  alignment() {
    return rt.CompactTypeBoolean.alignment().concat(
      rt.Bytes32Descriptor.alignment().concat(rt.Bytes32Descriptor.alignment()),
    );
  }
  fromValue(value: rt.Value) {
    return {
      is_left: rt.CompactTypeBoolean.fromValue(value),
      left: rt.Bytes32Descriptor.fromValue(value),
      right: rt.Bytes32Descriptor.fromValue(value),
    };
  }
  toValue(v: { is_left: boolean; left: Uint8Array; right: Uint8Array }) {
    return rt.CompactTypeBoolean.toValue(v.is_left).concat(
      rt.Bytes32Descriptor.toValue(v.left).concat(rt.Bytes32Descriptor.toValue(v.right)),
    );
  }
}
const eitherType = new EitherBytes32Type();

class OrderDetailsType implements rt.CompactType<OrderDetailsValue> {
  alignment() {
    return eitherType
      .alignment()
      .concat(
        rt.CompactTypeBoolean.alignment().concat(
          Uint128Type.alignment().concat(
            Uint128Type.alignment().concat(
              rt.ZswapCoinPublicKeyDescriptor.alignment().concat(Uint64Type.alignment()),
            ),
          ),
        ),
      );
  }
  fromValue(value: rt.Value): OrderDetailsValue {
    return {
      asset: eitherType.fromValue(value),
      isBuy: rt.CompactTypeBoolean.fromValue(value),
      price: Uint128Type.fromValue(value),
      amount: Uint128Type.fromValue(value),
      owner: rt.ZswapCoinPublicKeyDescriptor.fromValue(value),
      expiresAt: Uint64Type.fromValue(value),
    };
  }
  toValue(v: OrderDetailsValue) {
    return eitherType
      .toValue(v.asset)
      .concat(
        rt.CompactTypeBoolean.toValue(v.isBuy).concat(
          Uint128Type.toValue(v.price).concat(
            Uint128Type.toValue(v.amount).concat(
              rt.ZswapCoinPublicKeyDescriptor.toValue(v.owner).concat(
                Uint64Type.toValue(v.expiresAt),
              ),
            ),
          ),
        ),
      );
  }
}
const orderDetailsType = new OrderDetailsType();

export function computeCommitment(details: OrderDetailsValue, blinding: Uint8Array): Uint8Array {
  return rt.persistentCommit(orderDetailsType, details, blinding);
}
