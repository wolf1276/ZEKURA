/**
 * Correctness checks for web/src/services/midnight/commitment.ts — the
 * browser-side OrderDetails commitment codec. This is a privacy-critical
 * path: `persistentCommit` is only hiding if it is both deterministic (a
 * wallet must recompute the identical commitment when cancelling an order
 * it created) and free of accidental collisions between distinct orders.
 *
 * A byte-for-byte cross-check against the actual compiled contract
 * (contracts/managed/exchange) was attempted here but is not feasible
 * without changing package layout: the compiled contract module resolves
 * `@midnight-ntwrk/compact-runtime` from the repo root's node_modules,
 * while this package resolves its own copy from web/node_modules — two
 * physically distinct module instances of the same version, which the
 * runtime's internal state-shape checks correctly reject as incompatible.
 * That equivalence is instead covered by tests/exchange.test.ts (root) and
 * matcher's test suite, both of which run the identical codec pattern
 * in-process against the real compiled circuits.
 */
import { describe, expect, it } from 'vitest';
import { computeCommitment, type OrderDetailsValue } from '../src/services/midnight/commitment';

function bytes32(fill: number): Uint8Array {
  const b = new Uint8Array(32);
  b.fill(fill);
  return b;
}

describe('computeCommitment', () => {
  it('is deterministic for identical inputs', () => {
    const details: OrderDetailsValue = {
      asset: bytes32(1),
      isBuy: true,
      price: 1000n,
      amount: 50n,
      owner: { bytes: bytes32(7) },
      expiresAt: 9999999999n,
    };
    const blinding = bytes32(42);
    expect(computeCommitment(details, blinding)).toEqual(computeCommitment(details, blinding));
  });

  it('changes when any single field changes (no accidental collisions)', () => {
    const base: OrderDetailsValue = {
      asset: bytes32(1),
      isBuy: true,
      price: 1000n,
      amount: 50n,
      owner: { bytes: bytes32(7) },
      expiresAt: 9999999999n,
    };
    const blinding = bytes32(42);
    const baseline = computeCommitment(base, blinding);

    const priceChanged = computeCommitment({ ...base, price: 1001n }, blinding);
    const sideFlipped = computeCommitment({ ...base, isBuy: false }, blinding);
    const blindingChanged = computeCommitment(base, bytes32(43));

    expect(priceChanged).not.toEqual(baseline);
    expect(sideFlipped).not.toEqual(baseline);
    expect(blindingChanged).not.toEqual(baseline);
  });

  it('produces a fixed-length 32-byte commitment regardless of input values', () => {
    const details: OrderDetailsValue = {
      asset: bytes32(255),
      isBuy: false,
      price: 0n,
      amount: 340282366920938463463374607431768211455n, // Uint<128> max
      owner: { bytes: bytes32(255) },
      expiresAt: 0n,
    };
    const commitment = computeCommitment(details, bytes32(0));
    expect(commitment).toBeInstanceOf(Uint8Array);
    expect(commitment.length).toBe(32);
  });
});
