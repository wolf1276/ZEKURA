import { ORDER_STATUS_LABEL, ORDER_STATUS_STYLE } from "@/lib/order-status";
import { cn } from "@/lib/utils";
import type { OrderStatus } from "@/lib/types";

export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-medium tracking-wide",
        ORDER_STATUS_STYLE[status],
      )}
    >
      {ORDER_STATUS_LABEL[status].toUpperCase()}
    </span>
  );
}
