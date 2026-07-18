import type { AssetPair, MarketInsights } from "@/lib/types";

// ---------------------------------------------------------------------------
// Demo trading-pair asset registry
// ---------------------------------------------------------------------------
//
// This app's baseAssetId/quoteAssetId are Bytes<32> identifiers (64-hex) for
// its own demo trading pairs. They flow into an order's confidential `asset`
// field as Either.left(baseAssetId, quoteAssetId); the contract's
// deriveAssetKey(asset) hashes that whole Either into the on-chain
// Treasury/settlement key. The exchange treats the asset as an opaque id.
//
// tZKR (Zekura Test Token) is a REAL project-owned fungible token deployed on
// Preprod at the address below. IMPORTANT: this id is NOT a real on-chain
// unshielded token type — tZKR is built on OpenZeppelin Compact's
// FungibleToken module, which keeps balances in its own contract-internal
// ledger, not the chain's unshielded-color system the Exchange Treasury
// actually moves funds through (receiveUnshielded/sendUnshielded). So while
// this id is a genuine deployed contract address, the Exchange contract
// cannot custody it — deriveAssetKey(this id) is a hash with no real
// backing UTXOs, confirmed by a live read of the deployed Treasury ledger
// (it has zero entries for any tZKR-derived key, ever). See
// docs/ARCHITECTURE_TZKR_UNSHIELDED_MIGRATION.md for the full root cause and
// the production fix (rebuilding tZKR as a genuine unshielded token). tNIGHT
// keeps a stable placeholder id (it stands in for native NIGHT, which the
// contract never custodies via this field — NIGHT moves through
// settleWithProtocol's implicit nativeToken() payment leg instead).
//
//   tZKR Preprod contract: see README "Smart Contracts" address table.

/** Real deployed tZKR (Zekura Test Token) contract address on Preprod — used
 *  as the tZKR asset id so the default pair points at a live on-chain token. */
export const TZKR_ASSET_ID =
  "b16fbbec8ed99e38b16aa56166a646a1c71fd4a8e902fd0e357825d9a59efea4";

/** Stable placeholder id for native tNIGHT (the demo base asset). */
export const TNIGHT_ASSET_ID = "c3".padEnd(64, "0");

export const ASSET_PAIRS: AssetPair[] = [
  {
    id: "tNIGHT-tZKR",
    base: "tNIGHT",
    quote: "tZKR",
    baseAssetId: TNIGHT_ASSET_ID,
    quoteAssetId: TZKR_ASSET_ID,
  },
];

export const DEFAULT_PAIR = ASSET_PAIRS[0];

export function getMarketInsights(midPrice: number): MarketInsights {
  return {
    suggestedBuy: { low: round(midPrice * 0.976), high: round(midPrice * 1.005) },
    suggestedSell: { low: round(midPrice * 0.995), high: round(midPrice * 1.025) },
    liquidityZones: {
      strong: { low: round(midPrice * 0.976), high: round(midPrice * 1.005) },
      moderate: { low: round(midPrice * 1.0), high: round(midPrice * 1.036) },
      emerging: { low: round(midPrice * 1.036), high: round(midPrice * 1.06) },
    },
    activityLevel: "Medium",
    volatility: "Medium",
    estimatedSettlementSeconds: { low: 30, high: 90 },
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
