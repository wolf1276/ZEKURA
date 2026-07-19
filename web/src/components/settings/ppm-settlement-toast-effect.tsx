"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { usePendingSettlements } from "@/hooks/use-pending-settlements";
import { useOrderActions } from "@/hooks/use-order-actions";

/**
 * Surfaces the "Approve Settlement" step the moment a PPM quote reserves
 * (see use-order-actions.ts's settleWithProtocol) as a toast with an inline
 * action, instead of it only being discoverable by navigating to My Orders.
 * Quotes are short-lived (PricingEngine.ts's quoteTtlSeconds, 120s) — easy to
 * miss and let expire if the only affordance lives on a page the user isn't
 * looking at.
 */
export function PpmSettlementToastEffect() {
  const pending = usePendingSettlements();
  const { settleWithProtocol } = useOrderActions();
  const shown = useRef(new Set<string>());

  useEffect(() => {
    const nowSeconds = Date.now() / 1000;
    for (const p of pending) {
      if (shown.current.has(p.orderId)) continue;
      if (Number(p.expiresAt) <= nowSeconds) continue;
      shown.current.add(p.orderId);

      const secondsLeft = Math.max(0, Math.round(Number(p.expiresAt) - nowSeconds));
      toast.info("Protocol liquidity reserved — approve to settle", {
        description: `${p.side} ${p.amount} @ ${p.price} — expires in ~${secondsLeft}s`,
        duration: secondsLeft * 1000,
        action: {
          label: "Approve",
          onClick: () => {
            settleWithProtocol(p.orderId, p.quoteId)
              .then(() => toast.success("Settlement approved — transaction submitted."))
              .catch((err: unknown) =>
                toast.error("Couldn't approve settlement", {
                  description: err instanceof Error ? err.message : "Unknown error — try again.",
                }),
              );
          },
        },
      });
    }
  }, [pending, settleWithProtocol]);

  return null;
}
