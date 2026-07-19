import type { AssetPair, MarketInsights } from "@/lib/types";

// ---------------------------------------------------------------------------
// Trading-pair asset registry
// ---------------------------------------------------------------------------
//
// quoteAssetId is the traded (non-NIGHT) asset's real, chain-wide unshielded
// token color — it flows directly into an order's confidential `asset`
// field (contracts/exchange.compact's OrderDetails.asset is a plain
// Bytes<32> now, no Either/hashing indirection). baseAssetId is NIGHT's own
// all-zero color, kept here only as a stable display/lookup id — NIGHT never
// appears in OrderDetails.asset itself (it moves implicitly through
// settleWithProtocol's nativeToken() payment leg, and settle() never moves
// funds at all).
//
// tZKR (Zekura Test Token) is a genuine unshielded token minted by
// contracts/tzkr-token.compact (mintUnshieldedToken) — the same class of
// primitive NIGHT itself is built from, so it moves through the Exchange's
// Treasury exactly like NIGHT does. This replaces an earlier design built on
// OpenZeppelin Compact's FungibleToken module, whose contract-internal
// balance ledger could never be custodied by the Treasury (no chain-wide
// unshielded color, and no C2C support to bridge the two accounting
// systems) — see docs/ARCHITECTURE_TZKR_UNSHIELDED_MIGRATION.md for the full
// root cause this rebuild closes.
//
//   tZKR Preprod contract + real minted color: see README "Smart Contracts"
//   address table / Deployment.md.

/** tZKR's real minted unshielded token color on Preprod (see .midnight-tzkr.json / src/mint-tzkr.ts). */
export const TZKR_ASSET_ID =
  "5698abe70f5108b2b7607846049c4bf9890f50868686823b3fc8342f230a2760";

/** NIGHT's own all-zero unshielded token color (nativeToken()) — a stable display/lookup id, never itself written into OrderDetails.asset. */
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
