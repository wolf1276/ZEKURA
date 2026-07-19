"use client";

import { useCallback } from "react";
import { fromHex } from "@midnight-ntwrk/midnight-js-utils";
import { encodeUserAddress } from "@midnight-ntwrk/ledger-v8";
import { getNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { MidnightBech32m, UnshieldedAddress } from "@midnight-ntwrk/wallet-sdk-address-format";
import { useWalletContext } from "@/wallet/walletContext";
import { useNetworkContext } from "@/network/networkContext";
import { submitCancelOrder, submitSettleWithProtocol } from "@/services/midnight/exchangeContract";
import { forgetOrderWitnessData } from "@/services/midnight/orderStore";
import { forgetPendingSettlement } from "@/services/midnight/pendingSettlements";
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

  /**
   * Submits `settleWithProtocol(orderId, quoteId, recipient)` — the "Approve
   * Settlement" step a PPM fill requires from the order's own owner (see
   * contracts/exchange.compact's doc comment: receiveUnshielded always draws
   * from whoever submits, so the Matcher can no longer auto-execute this the
   * way it once did for BUY). `recipient` is always this wallet's own real
   * unshielded address — the traded asset (BUY) or NIGHT payment (SELL) pays
   * out there.
   */
  const settleWithProtocol = useCallback(
    async (orderId: string, quoteId: string): Promise<{ txId: string }> => {
      if (networkSwitching) {
        throw new Error("Network switch in progress — try again in a moment.");
      }
      const contractAddress = network.contractAddress;
      if (!contractAddress) {
        throw new Error(`Zekura's exchange contract isn't deployed on ${network.label} yet.`);
      }
      if (status !== "connected" || !wallet) {
        throw new WalletError("disconnected", "Connect your wallet before approving settlement.");
      }
      const connectedApi = getConnectedApi();
      if (!connectedApi) {
        throw new WalletError("disconnected", "Wallet connection was lost. Reconnect and try again.");
      }

      // encodeUserAddress expects the hex UserAddress form, not the bech32m
      // string wallet.unshieldedAddress is — same conversion
      // components/treasury/treasury-page.tsx's withdraw form uses.
      const ownAddressHex = MidnightBech32m.parse(wallet.unshieldedAddress)
        .decode(UnshieldedAddress, getNetworkId())
        .hexString;
      const recipientAddressBytes = encodeUserAddress(ownAddressHex);

      try {
        const result = await submitSettleWithProtocol({
          connectedApi,
          configuration: wallet.configuration,
          shielded: {
            shieldedCoinPublicKey: wallet.shieldedCoinPublicKey,
            shieldedEncryptionPublicKey: wallet.shieldedEncryptionPublicKey,
          },
          proofServerUri: network.proofServerUri,
          contractAddress,
          orderId: fromHex(orderId),
          quoteId: fromHex(quoteId),
          recipientAddressBytes,
        });

        // Real on-chain settlement succeeded — this quote is done, whether
        // or not the Matcher's own lazy reconciliation has caught up yet.
        forgetPendingSettlement(orderId);

        return result;
      } catch (err) {
        throw toWalletError(err);
      }
    },
    [status, wallet, getConnectedApi, network, networkSwitching],
  );

  return { cancelOrder, settleWithProtocol };
}
