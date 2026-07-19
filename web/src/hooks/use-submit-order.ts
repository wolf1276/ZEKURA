"use client";

import { useCallback, useState } from "react";
import { fromHex, toHex } from "@midnight-ntwrk/midnight-js-utils";
import { useWalletContext } from "@/wallet/walletContext";
import { useNetworkContext } from "@/network/networkContext";
import { computeCommitment, type OrderDetailsValue } from "@/services/midnight/commitment";
import { pureCircuits, submitCreateOrder } from "@/services/midnight/exchangeContract";
import { getOrCreateOwnerSecret } from "@/services/midnight/ownerSecret";
import { saveOrderWitnessData } from "@/services/midnight/orderStore";
import { savePendingSettlement } from "@/services/midnight/pendingSettlements";
import { toWalletError } from "@/wallet/walletConnector";
import { MatcherApiError, submitOrder } from "@/services/matcher/api";
import { expiryToUnixSeconds } from "@/lib/order-status";
import { setTxPending } from "@/network/networkBridge";
import { WalletError } from "@/wallet/walletTypes";
import type { AssetPair, ExpiryOption, Order, OrderSide } from "@/lib/types";

const INTEGER_STRING = /^[0-9]+$/;

export interface SubmitOrderInput {
  pair: AssetPair;
  side: OrderSide;
  /** Whole-number token-unit strings — the Matcher/contract accept plain integers only, no decimals. */
  amount: string;
  price: string;
  expiry: ExpiryOption;
}

export type SubmitOrderPhase =
  | { phase: "idle" }
  | { phase: "signing" }
  | { phase: "disclosing" }
  | { phase: "success"; order: Order }
  | { phase: "error"; message: string };

function hexToBytes32(hex: string): Uint8Array {
  const bytes = fromHex(hex);
  if (bytes.length !== 32) {
    throw new Error(`Expected a 32-byte hex value, got ${bytes.length} bytes`);
  }
  return bytes;
}

export function useSubmitOrder() {
  const { status, wallet, getConnectedApi } = useWalletContext();
  const { network, switching: networkSwitching } = useNetworkContext();
  const [state, setState] = useState<SubmitOrderPhase>({ phase: "idle" });

  const submit = useCallback(
    async (input: SubmitOrderInput): Promise<Order | null> => {
      try {
        if (networkSwitching) {
          throw new Error("Network switch in progress — try again in a moment.");
        }
        const contractAddress = network.contractAddress;
        if (!contractAddress) {
          throw new Error(
            `Zekura's exchange contract isn't deployed on ${network.label} yet. Switch networks or check back later.`,
          );
        }
        if (status === "unavailable") {
          throw new WalletError(
            "wallet-missing",
            "No Midnight wallet detected. Install 1AM Wallet (or another Midnight-compatible wallet) and refresh.",
          );
        }
        if (status === "unsupported-network") {
          throw new WalletError(
            "unsupported-network",
            `Your wallet is on a network Zekura doesn't support. Switch it to ${network.label} and reconnect.`,
          );
        }
        if (status !== "connected" || !wallet) {
          throw new WalletError("disconnected", "Connect your wallet before submitting an order.");
        }
        const connectedApi = getConnectedApi();
        if (!connectedApi) {
          throw new WalletError("disconnected", "Wallet connection was lost. Reconnect and try again.");
        }
        if (!INTEGER_STRING.test(input.amount) || !INTEGER_STRING.test(input.price)) {
          throw new Error("Amount and price must be whole numbers (no decimals) to submit on-chain.");
        }

        setState({ phase: "signing" });

        const orderId = crypto.getRandomValues(new Uint8Array(32));
        const blinding = crypto.getRandomValues(new Uint8Array(32));
        const ownerSecret = getOrCreateOwnerSecret();
        const ownerId = pureCircuits.deriveOwnerId(ownerSecret);
        const expiresAt = BigInt(expiryToUnixSeconds(input.expiry));

        const details: OrderDetailsValue = {
          // The contract's `asset` field only ever names the traded
          // (non-NIGHT) asset's real unshielded color — NIGHT itself is
          // handled implicitly via nativeToken() and never appears here (see
          // contracts/exchange.compact's OrderDetails doc comment). For this
          // app's tNIGHT/tZKR pair that's always the quote asset;
          // baseAssetId (tNIGHT's placeholder) plays no role in the order's
          // committed details.
          asset: hexToBytes32(input.pair.quoteAssetId),
          isBuy: input.side === "BUY",
          price: BigInt(input.price),
          amount: BigInt(input.amount),
          owner: { bytes: ownerId },
          expiresAt,
        };

        const commitment = computeCommitment(details, blinding);

        // Blocks network switching (see networkBridge.ts) for the on-chain
        // call below — it depends on the SDK's global network id and the
        // `contractAddress` captured at the top of this function, so a
        // switch mid-call would submit against a network that's no longer
        // the SDK's active one.
        setTxPending(true);
        try {
          // The wallet's approval pop-up happens inside this call
          // (balanceUnsealedTransaction / submitTransaction).
          await submitCreateOrder({
            connectedApi,
            configuration: wallet.configuration,
            shielded: {
              shieldedCoinPublicKey: wallet.shieldedCoinPublicKey,
              shieldedEncryptionPublicKey: wallet.shieldedEncryptionPublicKey,
            },
            proofServerUri: network.proofServerUri,
            contractAddress,
            orderId,
            commitment,
          });
        } finally {
          setTxPending(false);
        }

        setState({ phase: "disclosing" });

        const { order, pendingProtocolQuote } = await submitOrder({
          id: toHex(orderId),
          asset: input.pair.quoteAssetId,
          side: input.side,
          price: input.price,
          amount: input.amount,
          commitment: toHex(commitment),
          ownerId: toHex(ownerId),
          signature: toHex(blinding),
          expiresAt: expiresAt.toString(),
        });

        // Persist now that the order is confirmed live — cancelOrder and
        // settleWithProtocol both need to reconstruct these exact witnesses
        // later (see services/midnight/orderStore.ts).
        saveOrderWitnessData(orderId, details, blinding);

        // PPM reserved liquidity against this order but did not settle it —
        // the "Approve Settlement" step now needs this wallet's own
        // settleWithProtocol call (see hooks/use-order-actions.ts and
        // services/midnight/pendingSettlements.ts).
        if (pendingProtocolQuote) {
          savePendingSettlement({
            orderId: order.id,
            quoteId: pendingProtocolQuote.quoteId,
            side: input.side,
            price: pendingProtocolQuote.price,
            amount: pendingProtocolQuote.amount,
            expiresAt: pendingProtocolQuote.expiresAt,
          });
        }

        const uiOrder: Order = {
          id: order.id,
          pair: `${input.pair.base}/${input.pair.quote}`,
          side: order.side,
          price: order.price,
          amount: order.amount,
          status: order.status,
          createdAt: order.createdAt,
          expiresAt: order.expiresAt,
          expiryLabel: input.expiry,
          ownerId: order.ownerId,
        };

        setState({ phase: "success", order: uiOrder });
        return uiOrder;
      } catch (err) {
        const message =
          err instanceof WalletError
            ? err.message
            : err instanceof MatcherApiError
              ? err.message
              : toWalletError(err).message;
        setState({ phase: "error", message });
        return null;
      }
    },
    [status, wallet, getConnectedApi, network, networkSwitching],
  );

  const reset = useCallback(() => setState({ phase: "idle" }), []);

  return { state, submit, reset };
}
