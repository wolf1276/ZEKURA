"use client";

import { unshieldedToken } from "@midnight-ntwrk/ledger-v8";
import { TZKR_ASSET_ID } from "@/lib/mock/market";
import { useWalletContext } from "./walletContext";

/**
 * This demo exchange trades the tNIGHT / tZKR pair. Both are real unshielded
 * tokens — tZKR was rebuilt onto mintUnshieldedToken specifically so it moves
 * through the wallet's native unshielded balances exactly like NIGHT does
 * (see docs/ARCHITECTURE_TZKR_UNSHIELDED_MIGRATION.md) — so both symbols read
 * a real balance here, keyed by their real on-chain token color.
 */
export function useWallet() {
  const ctx = useWalletContext();

  function balanceFor(symbol: string): bigint {
    if (!ctx.wallet) return 0n;
    if (symbol === "tNIGHT") return ctx.wallet.unshieldedBalances[unshieldedToken().raw] ?? 0n;
    if (symbol === "tZKR") return ctx.wallet.unshieldedBalances[TZKR_ASSET_ID] ?? 0n;
    return 0n;
  }

  return {
    ...ctx,
    isConnected: ctx.status === "connected",
    balanceFor,
  };
}
