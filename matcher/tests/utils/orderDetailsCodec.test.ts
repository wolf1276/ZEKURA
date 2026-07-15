import { describe, expect, it } from 'vitest';

import type { Order } from '../../src/types/Order.js';
import { computeCommitmentHex, toOrderDetailsValue, verifyOrderSignature } from '../../src/utils/orderDetailsCodec.js';

/** `byte` must be exactly 2 hex chars; repeats it to a full 32-byte (64 char) hex string. */
function hexFill(byte: string): string {
  return byte.repeat(32);
}

function sampleOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: hexFill('01'),
    asset: { isLeft: true, left: hexFill('aa'), right: hexFill('00') },
    side: 'BUY',
    price: 1_000n,
    amount: 500n,
    commitment: '', // filled in below by the caller
    ownerId: hexFill('bb'),
    signature: hexFill('cc'), // blinding factor
    status: 'OPEN',
    createdAt: Date.now(),
    expiresAt: 9_999_999_999n,
    ...overrides,
  };
}

describe('orderDetailsCodec', () => {
  it('is deterministic: the same order+blinding always recomputes the same commitment', () => {
    const order = sampleOrder();
    const c1 = computeCommitmentHex(toOrderDetailsValue(order), order.signature);
    const c2 = computeCommitmentHex(toOrderDetailsValue(order), order.signature);
    expect(c1).toBe(c2);
    expect(c1).toHaveLength(64);
  });

  it('verifyOrderSignature accepts a correctly recomputed commitment', () => {
    const order = sampleOrder();
    const commitment = computeCommitmentHex(toOrderDetailsValue(order), order.signature);
    expect(verifyOrderSignature(order, commitment)).toBe(true);
  });

  it('verifyOrderSignature rejects a commitment computed from different order details (the P0-style forgery this scheme prevents)', () => {
    const order = sampleOrder();
    const commitment = computeCommitmentHex(toOrderDetailsValue(order), order.signature);
    const tampered = sampleOrder({ amount: 999n });
    expect(verifyOrderSignature(tampered, commitment)).toBe(false);
  });

  it('verifyOrderSignature rejects a mismatched blinding factor (wrong signature)', () => {
    const order = sampleOrder();
    const commitment = computeCommitmentHex(toOrderDetailsValue(order), order.signature);
    const wrongSignature = { ...order, signature: hexFill('ff') };
    expect(verifyOrderSignature(wrongSignature, commitment)).toBe(false);
  });

  it('every OrderDetails field participates in the commitment (changing any one changes the hash)', () => {
    const base = sampleOrder();
    const baseCommitment = computeCommitmentHex(toOrderDetailsValue(base), base.signature);

    const variants: Array<Partial<Order>> = [
      { side: 'SELL' },
      { price: base.price + 1n },
      { amount: base.amount + 1n },
      { ownerId: hexFill('99') },
      { expiresAt: base.expiresAt - 1n },
      { asset: { isLeft: false, left: base.asset.left, right: base.asset.right } },
      { asset: { isLeft: true, left: hexFill('11'), right: base.asset.right } },
    ];

    for (const variant of variants) {
      const varied = sampleOrder(variant);
      const variedCommitment = computeCommitmentHex(toOrderDetailsValue(varied), varied.signature);
      expect(variedCommitment).not.toBe(baseCommitment);
    }
  });

  it('handles boundary Uint<128>/Uint<64> values without overflow', () => {
    const uint128Max = 340282366920938463463374607431768211455n;
    const uint64Max = 18446744073709551615n;
    const order = sampleOrder({ price: uint128Max, amount: uint128Max, expiresAt: uint64Max });
    const commitment = computeCommitmentHex(toOrderDetailsValue(order), order.signature);
    expect(verifyOrderSignature(order, commitment)).toBe(true);
  });
});
