"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Check } from "lucide-react";
import { OrderStatusBadge } from "@/components/trade/order-status-badge";
import { formatOrderId, formatRelativeTime } from "@/lib/format";
import { matcher } from "@/services/matcher/matcherClient";
import { statusToStageIndex, TIMELINE_STAGES } from "@/lib/order-status";
import type { ActivityEvent, ActivityKind, Order } from "@/lib/types";

const STAGE_ACTIVITY_KIND: Partial<Record<number, ActivityKind>> = {
  0: "ORDER_CREATED",
  2: "ORDER_MATCHED",
  3: "SETTLEMENT_STARTED",
  4: "ORDER_FILLED",
};

interface OrderStatusTimelineProps {
  order: Order;
}

export function OrderStatusTimeline({ order }: OrderStatusTimelineProps) {
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const currentIndex = statusToStageIndex(order.status);

  useEffect(() => {
    return matcher.subscribeActivity((event) => {
      if (event.orderId !== order.id) return;
      setActivity((prev) => [...prev, event]);
    });
  }, [order.id]);

  function captionFor(stageIndex: number): string | null {
    const kind = STAGE_ACTIVITY_KIND[stageIndex];
    if (!kind) return null;
    const event = activity.find((a) => a.kind === kind);
    if (!event) return null;
    return formatRelativeTime(event.timestamp);
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4 md:p-5">
      <div className="mb-5 flex items-center justify-between">
        <p className="text-sm font-medium text-foreground">
          Order Status — {formatOrderId(order.id)}
        </p>
        <OrderStatusBadge status={order.status} />
      </div>

      <ol className="flex items-start gap-2">
        {TIMELINE_STAGES.map((stage, index) => {
          const done = index < currentIndex;
          const active = index === currentIndex;
          const caption = captionFor(index);

          return (
            <li
              key={stage.key}
              className="flex flex-1 flex-col items-center gap-2 text-center"
            >
              <div className="flex w-full items-center">
                <div className="flex-1">
                  {index > 0 && (
                    <div className="relative h-px w-full bg-border">
                      <motion.div
                        className="absolute inset-y-0 left-0 bg-primary"
                        initial={false}
                        animate={{ width: done || active ? "100%" : "0%" }}
                        transition={{ duration: 0.4, ease: "easeOut" }}
                      />
                    </div>
                  )}
                </div>
                <motion.div
                  initial={false}
                  animate={{ scale: active ? 1.1 : 1 }}
                  className={
                    "relative flex size-7 shrink-0 items-center justify-center rounded-full border-2 " +
                    (done
                      ? "border-primary bg-primary text-white"
                      : active
                        ? "border-primary bg-background text-primary"
                        : "border-border bg-background text-muted-foreground")
                  }
                >
                  {done ? (
                    <Check className="size-3.5" />
                  ) : (
                    <span
                      className={
                        "size-2 rounded-full " +
                        (active ? "bg-primary" : "bg-muted-foreground/40")
                      }
                    />
                  )}
                  {active && (
                    <motion.span
                      className="absolute inset-0 rounded-full border-2 border-primary"
                      animate={{ scale: [1, 1.6], opacity: [0.6, 0] }}
                      transition={{
                        duration: 1.4,
                        repeat: Infinity,
                        ease: "easeOut",
                      }}
                    />
                  )}
                </motion.div>
                <div className="flex-1">
                  {index < TIMELINE_STAGES.length - 1 && (
                    <div className="relative h-px w-full bg-border">
                      <motion.div
                        className="absolute inset-y-0 left-0 bg-primary"
                        initial={false}
                        animate={{ width: done ? "100%" : "0%" }}
                        transition={{ duration: 0.4, ease: "easeOut" }}
                      />
                    </div>
                  )}
                </div>
              </div>
              <div>
                <p
                  className={
                    "text-xs font-medium " +
                    (done || active ? "text-foreground" : "text-muted-foreground")
                  }
                >
                  {stage.label}
                </p>
                {caption && (
                  <p className="mt-0.5 text-[10px] text-muted-foreground">
                    {caption}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
