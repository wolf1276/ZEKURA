/**
 * The real on-chain identity of tNIGHT — distinct from the mock trading-pair
 * asset ids in lib/mock/market.ts (arbitrary placeholder hex, unrelated to
 * any real token type). The Treasury actually custodies this asset; admin
 * deposit/withdraw forms must use this key, never a trading-pair mock id.
 * Mirrors the exact encodeRawTokenType(unshieldedToken().raw) computation
 * already used server-side in scripts/e2e-check.ts and matcher/src/index.ts.
 */
import { unshieldedToken } from "@midnight-ntwrk/ledger-v8";
import { encodeRawTokenType } from "@midnight-ntwrk/compact-runtime";
import { toHex } from "@midnight-ntwrk/midnight-js-utils";

let cached: string | null = null;

export function nativeAssetKeyHex(): string {
  if (cached === null) {
    cached = toHex(encodeRawTokenType(unshieldedToken().raw));
  }
  return cached;
}
