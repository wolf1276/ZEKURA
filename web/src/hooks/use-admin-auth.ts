"use client";

import { useMemo } from "react";
import { useWallet } from "@/wallet/walletHooks";
import { requestAdminChallenge } from "@/services/matcher/api";
import type { AdminAuthPayload } from "@/types/matcher";

/**
 * NEXT_PUBLIC_ADMIN_ADDRESSES is a client-side hint only — it decides
 * whether the funding UI is even shown, never whether a request succeeds.
 * The real authorization boundary is server-side: the Matcher's own
 * MATCHER_ADMIN_ADDRESSES allowlist plus a real signature over a
 * server-issued nonce (see matcher/src/api/middleware/adminAuth.ts). A
 * mismatched or unset client-side list just means an authorized wallet
 * won't see the form; it can never let an unauthorized one through.
 */
function parseAllowlist(value: string | undefined): ReadonlySet<string> {
  if (!value || value.trim() === "") return new Set();
  return new Set(value.split(",").map((s) => s.trim()).filter(Boolean));
}

const CLIENT_ADMIN_ALLOWLIST = parseAllowlist(process.env.NEXT_PUBLIC_ADMIN_ADDRESSES);

export function useAdminAuth() {
  const { wallet, getConnectedApi } = useWallet();

  const isAdminAddress = useMemo(
    () => !!wallet && CLIENT_ADMIN_ALLOWLIST.has(wallet.unshieldedAddress),
    [wallet],
  );

  /**
   * Runs the full challenge/response flow and returns a payload ready for
   * an admin-gated Matcher request: fetches a fresh single-use nonce for
   * this wallet's address, then asks the connected wallet to sign it with
   * its unshielded key (a real digital signature — see
   * matcher/src/api/middleware/adminAuth.ts's doc comment on why this
   * isn't the on-chain witness+commitment scheme). Throws if no wallet is
   * connected, the wallet rejects the signature, or the address isn't
   * recognized by the Matcher.
   */
  async function signAdminRequest(): Promise<AdminAuthPayload> {
    if (!wallet) throw new Error("Connect a wallet first");
    const api = getConnectedApi();
    if (!api) throw new Error("Wallet connection is not active");

    const { nonce } = await requestAdminChallenge({ address: wallet.unshieldedAddress });
    const { signature, verifyingKey } = await api.signData(nonce, { encoding: "hex", keyType: "unshielded" });

    return { address: wallet.unshieldedAddress, publicKey: verifyingKey, signature };
  }

  return { isAdminAddress, signAdminRequest };
}
