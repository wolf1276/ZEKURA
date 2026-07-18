"use client";

import { useCallback } from "react";
import { fromHex } from "@midnight-ntwrk/midnight-js-utils";
import { useWalletContext } from "@/wallet/walletContext";
import { useNetworkContext } from "@/network/networkContext";
import { submitCancelOrder } from "@/services/midnight/exchangeContract";
import { forgetOrderWitnessData } from "@/services/midnight/orderStore";
import { toWalletError } from "@/wallet/walletConnector";
import { cancelOrder as cancelOrderOffChain } from "@/services/matcher/api";
import { WalletError } from "@/wallet/walletTypes";

/**
 * The real on-chain half of order actions this app's wallet can submit
 * itself. `cancelOrder` here is a real `cancelOrder(orderId)` circuit call —
 * distinct from (and a prerequisite alongside) the Matcher's own DELETE
 * /orders/:id, which only ever updates the Matcher's local off-chain view
 * (see matcher/API.md and app/api/matcher/orders/[id]/route.ts). Requires
 * this browser profile to hold the order's real committed details/blinding
 * (services/midnight/orderStore.ts) and ownerSecretKey
 * (services/midnight/ownerSecret.ts) — only the profile that created the
 * order can cancel it, enforced on-chain (AUDIT.md P0-1).
 */
export function useOrderActions() {
  const { status, wallet, getConnectedApi } = useWalletContext();
  const { network, switching: networkSwitching } = useNetworkContext();

  const cancelOrder = useCallback(
    async (orderId: string): Promise<{ txId: string }> => {
      if (networkSwitching) {
        throw new Error("Network switch in progress — try again in a moment.");
      }
      const contractAddress = network.contractAddress;
      if (!contractAddress) {
        throw new Error(`Zekura's exchange contract isn't deployed on ${network.label} yet.`);
      }
      if (status !== "connected" || !wallet) {
        throw new WalletError("disconnected", "Connect your wallet before cancelling an order.");
      }
      const connectedApi = getConnectedApi();
      if (!connectedApi) {
        throw new WalletError("disconnected", "Wallet connection was lost. Reconnect and try again.");
      }

      try {
        const result = await submitCancelOrder({
          connectedApi,
          configuration: wallet.configuration,
          shielded: {
            shieldedCoinPublicKey: wallet.shieldedCoinPublicKey,
            shieldedEncryptionPublicKey: wallet.shieldedEncryptionPublicKey,
          },
          proofServerUri: network.proofServerUri,
          contractAddress,
          orderId: fromHex(orderId),
        });

        // Real on-chain cancellation succeeded — the local witness record
        // for this order is now dead weight (CANCELLED is terminal, per
        // contracts/exchange.compact's state machine). Also tell the
        // Matcher immediately, rather than waiting on a reconciliation pass
        // this contract doesn't have for cancellations, so the UI reflects
        // it right away instead of only on next expiry-style sweep.
        forgetOrderWitnessData(fromHex(orderId));
        await cancelOrderOffChain(orderId).catch(() => {
          // The on-chain cancellation is the source of truth and already
          // succeeded; a failure here just means the Matcher's local view
          // is briefly stale until its own indexer-backed reconciliation
          // catches up.
        });

        return result;
      } catch (err) {
        throw toWalletError(err);
      }
    },
    [status, wallet, getConnectedApi, network, networkSwitching],
  );

  return { cancelOrder };
}
