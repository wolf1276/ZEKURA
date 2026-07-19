/** 64 lowercase hex characters — the wire form of a Compact `Bytes<32>`. */
export type Hex32 = string;

/**
 * The traded (non-NIGHT) asset's real, chain-wide unshielded token color —
 * identical in shape and value to the on-chain `OrderDetails.asset` field
 * and the Treasury's `assetKey` (both are now plain `Bytes<32>`, see
 * contracts/exchange.compact). The contract's `settle()` compares
 * `buyDetails.asset == sellDetails.asset` directly, so the Matcher's own
 * pre-match asset check (and its order-book partition key) uses the same
 * direct equality to guarantee anything it considers "matched" will
 * actually be accepted by settle().
 *
 * Previously an `{isLeft, left, right}` tuple hashed through `deriveAssetKey`
 * into an arbitrary key with no real chain meaning (the pre-2026-07-19 tZKR
 * design, built on a contract-internal FungibleToken ledger that could never
 * be custodied by Treasury — see
 * docs/ARCHITECTURE_TZKR_UNSHIELDED_MIGRATION.md). Now that tZKR is a
 * genuine unshielded token, this type is simply the real color, with no
 * hashing indirection to get wrong.
 */
export type Asset = Hex32;

/** Stable partition key for the order book — one bucket per distinct asset color. */
export function assetKey(asset: Asset): string {
  return asset;
}

export function assetsEqual(a: Asset, b: Asset): boolean {
  return a === b;
}
