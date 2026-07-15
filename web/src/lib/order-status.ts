import type { ActivityKind, OrderStatus, OrderTimelineStage } from "@/lib/types";

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  OPEN: "Open",
  MATCHED: "Matched",
  SETTLING: "Settling",
  FILLED: "Filled",
  CANCELLED: "Cancelled",
  EXPIRED: "Expired",
  FAILED: "Failed",
};

/** Monochrome-first badge styling — purple only for active/in-flight states. */
export const ORDER_STATUS_STYLE: Record<OrderStatus, string> = {
  OPEN: "border-border text-foreground/80",
  MATCHED: "border-primary/40 text-primary bg-primary/10",
  SETTLING: "border-primary/40 text-primary bg-primary/10",
  FILLED: "border-border text-foreground bg-white/[0.04]",
  CANCELLED: "border-border text-muted-foreground",
  EXPIRED: "border-border text-muted-foreground",
  FAILED: "border-destructive/40 text-destructive bg-destructive/10",
};

export const TIMELINE_STAGES: { key: OrderTimelineStage; label: string }[] = [
  { key: "CREATED", label: "Created" },
  { key: "SEARCHING", label: "Searching for Match" },
  { key: "MATCHED", label: "Matched" },
  { key: "SETTLED", label: "Settled" },
  { key: "COMPLETED", label: "Completed" },
];

export function statusToStageIndex(status: OrderStatus): number {
  switch (status) {
    case "OPEN":
      return 1; // created + actively searching
    case "MATCHED":
      return 2;
    case "SETTLING":
      return 3;
    case "FILLED":
      return 4;
    default:
      return 0;
  }
}

export const ACTIVITY_LABEL: Record<ActivityKind, string> = {
  ORDER_CREATED: "Order Created",
  ORDER_MATCHED: "Matched",
  SETTLEMENT_STARTED: "Settlement Started",
  ORDER_FILLED: "Filled",
  ORDER_CANCELLED: "Cancelled",
  ORDER_EXPIRED: "Expired",
};
