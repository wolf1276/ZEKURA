import type {
  ActivityKind,
  ExpiryOption,
  OrderStatus,
  OrderTimelineStage,
} from "@/lib/types";

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
  ORDER_FAILED: "Failed",
  TREASURY_DEPOSITED: "Treasury Deposit",
  TREASURY_WITHDRAWN: "Treasury Withdrawal",
  TREASURY_RESERVED: "Liquidity Reserved",
  TREASURY_RELEASED: "Liquidity Released",
  TREASURY_EXECUTED: "Protocol Fill Executed",
};

/** Converts a trade-panel expiry selection into a Matcher-facing unix-second deadline. */
export function expiryToUnixSeconds(expiry: ExpiryOption): number {
  const now = Math.floor(Date.now() / 1000);
  switch (expiry) {
    case "10m":
      return now + 600;
    case "30m":
      return now + 1800;
    case "1h":
      return now + 3600;
    case "GTC":
      return 9999999999;
  }
}
