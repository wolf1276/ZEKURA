/**
 * The `ownerSecretKey` witness in contracts/exchange.compact is explicitly
 * NOT a real Zswap/Lace wallet key — it's a DApp-local secret whose only
 * job is to let this browser profile derive the same `deriveOwnerId(...)`
 * value it embedded in an order's `owner` field when creating it, so it can
 * later prove ownership (see the contract's comments on `ownerSecretKey`).
 *
 * Lace does not implement `signData()`, so there's no documented way to
 * derive this deterministically from the connected wallet. The sanctioned
 * pattern (Midnight's own leaderboard/bboard browser tutorials) is a random
 * 32-byte secret generated once and persisted in localStorage.
 */

const STORAGE_KEY = "zekura:owner-secret";

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function getOrCreateOwnerSecret(): Uint8Array {
  if (typeof window === "undefined") {
    throw new Error("getOrCreateOwnerSecret can only be called in the browser");
  }
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored) {
    const bytes = base64ToBytes(stored);
    if (bytes.length === 32) return bytes;
  }
  const secret = crypto.getRandomValues(new Uint8Array(32));
  window.localStorage.setItem(STORAGE_KEY, bytesToBase64(secret));
  return secret;
}
