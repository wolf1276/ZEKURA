"use client";

import { useCallback, useState } from "react";
import { fromHex, toHex } from "@midnight-ntwrk/midnight-js-utils";
import { useWalletContext } from "@/providers/wallet-provider";
import { computeCommitment, type OrderDetailsValue } from "@/services/midnight/commitment";
import { pureCircuits, submitCreateOrder } from "@/services/midnight/exchangeContract";
import { getOrCreateOwnerSecret } from "@/services/midnight/ownerSecret";
import { toWalletError } from "@/services/midnight/walletConnector";
import { MatcherApiError, submitOrder } from "@/services/matcher/api";
import { expiryToUnixSeconds } from "@/lib/order-status";
import { WalletError } from "@/types/wallet";
import type { AssetPair, ExpiryOption, Order, OrderSide } from "@/lib/types";

const CONTRACT_ADDRESS = process.env.NEXT_PUBLIC_EXCHANGE_CONTRACT_ADDRESS?.trim() ?? "";

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
  const [state, setState] = useState<SubmitOrderPhase>({ phase: "idle" });

  const submit = useCallback(
    async (input: SubmitOrderInput): Promise<Order | null> => {
      try {
        if (!CONTRACT_ADDRESS) {
          throw new Error(
            "NEXT_PUBLIC_EXCHANGE_CONTRACT_ADDRESS is not configured — see web/.env.example.",
          );
        }
        if (status === "unavailable") {
          throw new WalletError(
            "wallet-missing",
            "No Midnight wallet detected. Install 1AM Wallet (or another Midnight-compatible wallet) and refresh.",
          );
        }
        if (status === "wrong-network") {
          throw new WalletError(
            "wrong-network",
            `Your wallet is on the wrong network. Switch it to ${process.env.NEXT_PUBLIC_NETWORK_ID?.trim() || "preprod"} and reconnect.`,
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
          // This app's baseAssetId/quoteAssetId are placeholder Bytes<32>
          // identifiers for its own demo trading pairs (see lib/mock/market.ts)
          // — the contract's `asset` field doesn't document which side of
          // Either is "base" vs "quote", so `left`/`right` here are just this
          // app's own consistent convention for round-tripping the pair.
          asset: { is_left: true, left: hexToBytes32(input.pair.baseAssetId), right: hexToBytes32(input.pair.quoteAssetId) },
          isBuy: input.side === "BUY",
          price: BigInt(input.price),
          amount: BigInt(input.amount),
          owner: { bytes: ownerId },
          expiresAt,
        };

        const commitment = computeCommitment(details, blinding);

        // The wallet's approval pop-up happens inside this call
        // (balanceUnsealedTransaction / submitTransaction).
        await submitCreateOrder({
          connectedApi,
          configuration: wallet.configuration,
          shielded: {
            shieldedCoinPublicKey: wallet.shieldedCoinPublicKey,
            shieldedEncryptionPublicKey: wallet.shieldedEncryptionPublicKey,
          },
          contractAddress: CONTRACT_ADDRESS,
          orderId,
          commitment,
        });

        setState({ phase: "disclosing" });

        const { order } = await submitOrder({
          id: toHex(orderId),
          asset: { isLeft: true, left: input.pair.baseAssetId, right: input.pair.quoteAssetId },
          side: input.side,
          price: input.price,
          amount: input.amount,
          commitment: toHex(commitment),
          ownerId: toHex(ownerId),
          signature: toHex(blinding),
          expiresAt: expiresAt.toString(),
        });

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
    [status, wallet, getConnectedApi],
  );

  const reset = useCallback(() => setState({ phase: "idle" }), []);

  return { state, submit, reset };
}
