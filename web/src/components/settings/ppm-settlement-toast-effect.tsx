"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { usePendingSettlements } from "@/hooks/use-pending-settlements";
import { useOrderActions } from "@/hooks/use-order-actions";
import {
  markSettlingInFlight,
  unmarkSettlingInFlight,
  forgetPendingSettlement,
  shouldAutoSettle,
} from "@/services/midnight/pendingSettlements";
import { getOrder, isRetryableMatcherError } from "@/services/matcher/api";
import { retryWithBackoff } from "@/lib/retry";

const FRESHNESS_CHECK_RETRY_DELAYS_MS = [500, 1000, 2000];

/**
 * The moment a PPM quote reserves (see use-order-actions.ts's
 * settleWithProtocol), automatically submits settleWithProtocol — the
 * wallet's own extension popup is the only user interaction required, no
 * "Approve" click first. Quotes are short-lived (PricingEngine.ts's
 * quoteTtlSeconds, 120s), so waiting on a click the user might not see (this
 * effect mounts app-wide, not just on My Orders) risked losing the reservation.
 */
export function PpmSettlementToastEffect() {
  const pending = usePendingSettlements();
  const { settleWithProtocol } = useOrderActions();
  const started = useRef(new Set<string>());

  useEffect(() => {
    const unmounted = { current: false };
    const nowSeconds = Date.now() / 1000;

    for (const p of pending) {
      if (started.current.has(p.orderId)) continue;
      if (Number(p.expiresAt) <= nowSeconds) continue;
      if (!markSettlingInFlight(p.orderId)) continue;
      started.current.add(p.orderId);

      // A page reload loses the in-memory started/inFlight guards but not
      // the localStorage entry, so on remount this could be a resubmission
      // of a settleWithProtocol that's already landed (or is still
      // in-flight from before the reload). Reconcile against the backend
      // (which itself reconciles against chain state — OrderService's
      // reconcileProtocolFill) before ever reopening the wallet. Retries
      // only cover getting an answer out of the Matcher at all (network
      // blips, 5xx) — the settlement decision itself still runs exactly
      // once, on whichever fresh read finally comes back.
      retryWithBackoff(() => getOrder(p.orderId), {
        delaysMs: FRESHNESS_CHECK_RETRY_DELAYS_MS,
        isRetryable: isRetryableMatcherError,
        isCancelled: () => unmounted.current,
      })
        .then(({ order }) => {
          if (!shouldAutoSettle(order.status, p.expiresAt, Date.now() / 1000)) {
            forgetPendingSettlement(p.orderId);
            return;
          }

          const toastId = toast.info("Waiting for wallet signature…", {
            description: `${p.side} ${p.amount} @ ${p.price} — approve in your wallet to settle.`,
            duration: Infinity,
          });

          return settleWithProtocol(p.orderId, p.quoteId)
            .then(() => {
              toast.success("Trade complete", { id: toastId, description: "Settlement transaction submitted." });
            })
            .catch((err: unknown) => {
              toast.error("Couldn't approve settlement", {
                id: toastId,
                description: err instanceof Error ? err.message : "Unknown error — try again.",
              });
            });
        })
        .catch((err: unknown) => {
          // Either a non-retryable freshness-check failure (order not
          // found, etc.) or we ran out of retries, or the component
          // unmounted mid-retry (CancelledError). In every case: leave the
          // local entry alone and let the next mount or the manual Approve
          // Settlement button retry, rather than risk firing on stale
          // local state or reopening the wallet after unmount.
          void err;
        })
        .finally(() => unmarkSettlingInFlight(p.orderId));
    }

    return () => {
      unmounted.current = true;
    };
  }, [pending, settleWithProtocol]);

  return null;
}
