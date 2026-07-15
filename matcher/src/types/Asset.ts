/** 64 lowercase hex characters — the wire form of a Compact `Bytes<32>`. */
export type Hex32 = string;

/**
 * Mirrors the contract's `Either<Bytes<32>, Bytes<32>>` asset field exactly,
 * including the inactive branch. The contract's `settle()` compares
 * `buyDetails.asset == sellDetails.asset` as full structural equality over
 * `(isLeft, left, right)` — not just the active branch — so the Matcher's
 * own pre-match asset check (and its order-book partition key) must use the
 * same full-tuple equality to guarantee anything it considers "matched"
 * will actually be accepted by settle(). See ARCHITECTURE.md's security
 * model section.
 */
export interface Asset {
  readonly isLeft: boolean;
  readonly left: Hex32;
  readonly right: Hex32;
}

/** Stable partition key for the order book — one bucket pair per distinct asset tuple. */
export function assetKey(asset: Asset): string {
  return `${asset.isLeft ? '1' : '0'}:${asset.left}:${asset.right}`;
}

export function assetsEqual(a: Asset, b: Asset): boolean {
  return a.isLeft === b.isLeft && a.left === b.left && a.right === b.right;
}
