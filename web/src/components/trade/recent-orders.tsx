"use client";

import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Inbox } from "lucide-react";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { OrderStatusBadge } from "@/components/trade/order-status-badge";
import {
  formatAmount,
  formatExpiry,
  formatOrderId,
  formatPrice,
  formatRelativeTime,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Order } from "@/lib/types";

const OPEN_STATUSES: Order["status"][] = ["OPEN", "MATCHED", "SETTLING"];
const HISTORY_STATUSES: Order["status"][] = [
  "FILLED",
  "CANCELLED",
  "EXPIRED",
  "FAILED",
];

interface RecentOrdersProps {
  orders: Order[];
  onCancel: (id: string) => void;
  /** orderId -> who supplied the counterparty side of the fill — see hooks/use-market-data.ts's order.filled handling. Absent for an order that hasn't filled (or filled before this session started tracking it). */
  matchedWith?: Record<string, "user" | "protocol">;
}

function MatchedWithBadge({ source }: { source: "user" | "protocol" }) {
  return (
    <span
      className={cn(
        "ml-2 rounded-full border px-1.5 py-0.5 text-[10px] font-medium",
        source === "protocol"
          ? "border-primary/30 bg-primary/10 text-primary"
          : "border-border text-muted-foreground",
      )}
    >
      {source === "protocol" ? "Protocol Liquidity" : "User"}
    </span>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-14 text-center">
      <Inbox className="size-6 text-muted-foreground/50" />
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
  );
}

function OrdersTable({
  orders,
  timeLabel,
  onCancel,
  matchedWith,
}: {
  orders: Order[];
  timeLabel: string;
  onCancel: (id: string) => void;
  matchedWith: Record<string, "user" | "protocol">;
}) {
  if (orders.length === 0) {
    return (
      <EmptyState
        message={
          timeLabel === "Expiration"
            ? "No open orders yet — submit one from the panel above."
            : "No order history yet."
        }
      />
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-left text-sm">
        <thead>
          <tr className="border-b border-border text-xs text-muted-foreground">
            <th className="py-2 pr-4 font-medium">Order ID</th>
            <th className="py-2 pr-4 font-medium">Asset</th>
            <th className="py-2 pr-4 font-medium">Side</th>
            <th className="py-2 pr-4 font-medium">Amount</th>
            <th className="py-2 pr-4 font-medium">Price</th>
            <th className="py-2 pr-4 font-medium">Status</th>
            <th className="py-2 pr-2 font-medium">{timeLabel}</th>
            <th className="py-2 pr-2" />
          </tr>
        </thead>
        <tbody>
          <AnimatePresence initial={false}>
            {orders.map((order) => (
              <motion.tr
                key={order.id}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="border-b border-border/60 last:border-0"
              >
                <td className="py-2.5 pr-4 font-mono text-xs text-foreground/80">
                  {formatOrderId(order.id)}
                </td>
                <td className="py-2.5 pr-4 text-foreground/90">
                  {order.pair}
                </td>
                <td
                  className={cn(
                    "py-2.5 pr-4 font-medium",
                    order.side === "BUY" ? "text-foreground" : "text-foreground/70",
                  )}
                >
                  {order.side === "BUY" ? "Buy" : "Sell"}
                </td>
                <td className="py-2.5 pr-4 font-mono tabular-nums text-foreground/90">
                  {formatAmount(order.amount)}
                </td>
                <td className="py-2.5 pr-4 font-mono tabular-nums text-foreground/90">
                  {formatPrice(order.price)}
                </td>
                <td className="py-2.5 pr-4">
                  <span className="inline-flex items-center">
                    <OrderStatusBadge status={order.status} />
                    {order.status === "FILLED" && matchedWith[order.id] && (
                      <MatchedWithBadge source={matchedWith[order.id]!} />
                    )}
                  </span>
                </td>
                <td className="py-2.5 pr-2 font-mono text-xs tabular-nums text-muted-foreground">
                  {timeLabel === "Expiration"
                    ? formatExpiry(order.expiresAt)
                    : formatRelativeTime(order.createdAt)}
                </td>
                <td className="py-2.5 pr-2 text-right">
                  {order.status === "OPEN" && (
                    <button
                      onClick={() => onCancel(order.id)}
                      className="rounded px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-white/[0.05] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      Cancel
                    </button>
                  )}
                </td>
              </motion.tr>
            ))}
          </AnimatePresence>
        </tbody>
      </table>
    </div>
  );
}

export function RecentOrders({ orders, onCancel, matchedWith = {} }: RecentOrdersProps) {
  const [tab, setTab] = useState("open");

  const openOrders = useMemo(
    () => orders.filter((o) => OPEN_STATUSES.includes(o.status)),
    [orders],
  );
  const historyOrders = useMemo(
    () => orders.filter((o) => HISTORY_STATUSES.includes(o.status)),
    [orders],
  );

  return (
    <div className="p-4 md:p-5">
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="bg-transparent p-0">
          <TabsTrigger
            value="open"
            className="rounded-none border-b-2 border-transparent px-0 py-2 mr-6 data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
          >
            Open Orders
          </TabsTrigger>
          <TabsTrigger
            value="history"
            className="rounded-none border-b-2 border-transparent px-0 py-2 data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
          >
            Order History
          </TabsTrigger>
        </TabsList>
        <div className="mt-3 border-t border-border pt-3">
          <TabsContent value="open" className="mt-0">
            <OrdersTable
              orders={openOrders}
              timeLabel="Expiration"
              onCancel={onCancel}
              matchedWith={matchedWith}
            />
          </TabsContent>
          <TabsContent value="history" className="mt-0">
            <OrdersTable
              orders={historyOrders}
              timeLabel="Time"
              onCancel={onCancel}
              matchedWith={matchedWith}
            />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}
