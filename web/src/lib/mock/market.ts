import type { AssetPair, MarketInsights } from "@/lib/types";

// ---------------------------------------------------------------------------
// Demo trading-pair asset registry
// ---------------------------------------------------------------------------
//
// Each pair's on-chain `asset` field is an Either<Bytes<32>, Bytes<32>> — see
// lib/types.ts's AssetPair doc comment for what `assetIsLeft` controls and
// why only an `assetIsLeft: false` pair can ever be Treasury/PPM-funded.
//
//   tZKR Preprod contract: see README "Smart Contracts" address table.

/** Real deployed tZKR (Zekura Test Token) contract address on Preprod. NOT
 *  currently used as a pair's on-chain `asset` id — see PPM_ASSET_ADAPTER's
 *  doc comment for why, and what real integration would require. */
export const TZKR_ASSET_ID =
  "b16fbbec8ed99e38b16aa56166a646a1c71fd4a8e902fd0e357825d9a59efea4";

/** Stable placeholder id for native tNIGHT (display-only; distinct from the PPM adapter's real NIGHT token type below). */
export const TNIGHT_ASSET_ID = "c3".padEnd(64, "0");

/**
 * PPM asset adapter — hackathon placeholder for the pair the PPM/Treasury
 * demo actually trades, kept deliberately separate from TZKR_ASSET_ID/
 * TNIGHT_ASSET_ID above so swapping it later touches exactly one place.
 *
 * `quoteAssetId` here is nativeToken()'s real on-chain token type (32 zero
 * bytes) — with `assetIsLeft: false`, contracts/exchange.compact's
 * deriveAssetKey returns it unchanged, so Treasury deposits/reserves/
 * settleWithProtocol all move genuine NIGHT the operator wallet actually
 * holds. It is NOT a tNIGHT/tZKR pair; `base`/`quote` labels are cosmetic
 * for this adapter and intentionally say so.
 *
 * tZKR migration path (once exchange.compact can call into tzkr-token.compact
 * — see contracts/tzkr-token.compact's header: tZKR is a fully custom
 * OpenZeppelin FungibleToken contract, not a native unshielded token, so
 * receiveUnshielded/sendUnshielded cannot move it today):
 *   1. Give exchange.compact a cross-contract call into tzkr-token's
 *      transfer/transferFrom for the asset leg (settleWithProtocol,
 *      depositTreasury, withdrawTreasury).
 *   2. Replace this adapter entry with `quoteAssetId: TZKR_ASSET_ID`.
 *   3. Nothing else in web/matcher changes — every consumer reads
 *      ASSET_PAIRS/DEFAULT_PAIR, never this adapter's fields directly.
 */
const PPM_ASSET_ADAPTER: AssetPair = {
  id: "NIGHT-PPM-DEMO",
  base: "NIGHT",
  quote: "NIGHT (PPM demo adapter)",
  baseAssetId: "00".repeat(32),
  quoteAssetId: "00".repeat(32),
  assetIsLeft: false,
};

export const ASSET_PAIRS: AssetPair[] = [PPM_ASSET_ADAPTER];

export const DEFAULT_PAIR = ASSET_PAIRS[0];
