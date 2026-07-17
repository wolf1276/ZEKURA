"use client";

import { unshieldedToken } from "@midnight-ntwrk/ledger-v8";
import { useWalletContext } from "./walletContext";

/**
 * This demo exchange trades the tNIGHT / tZKR pair. tNIGHT is the one symbol
 * that corresponds to a real balance the wallet holds (native NIGHT), so its
 * balance is real. tZKR is a real project-owned fungible token, but its
 * balances live in the tZKR token contract's own ledger (keyed by a derived
 * account id), not in the wallet's native unshielded balances — and the
 * exchange contract itself is a commitment registry that never moves real
 * balances (see README.md's Level 1 scope). So any non-tNIGHT symbol honestly
 * shows 0 here rather than a fabricated number.
 */
export function useWallet() {
  const ctx = useWalletContext();

  function balanceFor(symbol: string): bigint {
    if (!ctx.wallet) return 0n;
    if (symbol !== "tNIGHT") return 0n;
    return ctx.wallet.unshieldedBalances[unshieldedToken().raw] ?? 0n;
  }

  return {
    ...ctx,
    isConnected: ctx.status === "connected",
    balanceFor,
  };
}
