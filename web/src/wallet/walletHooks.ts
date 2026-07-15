"use client";

import { unshieldedToken } from "@midnight-ntwrk/ledger-v8";
import { useWalletContext } from "./walletContext";

/**
 * This demo exchange trades placeholder pairs (tDUST/tUSD/tNIGHT) that are
 * not real minted tokens the wallet can hold — the contract is a
 * commitment registry only (see README.md's Level 1 scope), so it never
 * moves real balances. tNIGHT is the one pair symbol that does correspond
 * to a real token (native NIGHT), so its balance is real; the others
 * honestly show 0 rather than a fabricated number.
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
