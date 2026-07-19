"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, Search, X, Check } from "lucide-react";
import { toast } from "sonner";
import { PageShell, Card } from "@/components/layout/page-shell";
import { OrderStatusBadge } from "@/components/trade/order-status-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useWallet } from "@/wallet/walletHooks";
import { useOrderActions } from "@/hooks/use-order-actions";
import { usePendingSettlements } from "@/hooks/use-pending-settlements";
import { matcher } from "@/services/matcher/matcherClient";
import {
  formatAmount,
  formatOrderId,
  formatPrice,
  formatRelativeTime,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Order, OrderStatus } from "@/lib/types";

const TABS: { label: string; statuses: OrderStatus[] }[] = [
  { label: "Open", statuses: ["OPEN", "MATCHED", "SETTLING"] },
  { label: "Filled", statuses: ["FILLED"] },
  { label: "Cancelled", statuses: ["CANCELLED", "FAILED"] },
  { label: "Expired", statuses: ["EXPIRED"] },
];

const PAGE_SIZE = 7;

function filledPercent(status: OrderStatus): number {
  return status === "FILLED" ? 100 : status === "SETTLING" ? 50 : 0;
}

function toCsv(orders: Order[]): string {
  const head = "Pair,Side,LimitPrice,Amount,FilledPct,Status,Created";
  const rows = orders.map((o) =>
    [
      o.pair,
      o.side,
      o.price,
      o.amount,
      filledPercent(o.status),
      o.status,
      new Date(o.createdAt).toISOString(),
    ].join(","),
  );
  return [head, ...rows].join("\n");
}

export function OrdersPage() {
  const { balanceFor } = useWallet();
  const { cancelOrder, settleWithProtocol } = useOrderActions();
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState(0);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const pendingSettlements = usePendingSettlements();
  const [approving, setApproving] = useState<string | null>(null);

  useEffect(
    () =>
      matcher.subscribe((next) => {
        setOrders(next);
        setLoading(!matcher.isReady());
      }),
    [],
  );

  const pendingByOrderId = useMemo(
    () => new Map(pendingSettlements.map((p) => [p.orderId, p])),
    [pendingSettlements],
  );

  const handleCancel = useCallback(
    (id: string) => {
      // Real on-chain cancelOrder — not just the Matcher's off-chain view
      // (see hooks/use-order-actions.ts for why both matter).
      cancelOrder(id).catch((err: unknown) => {
        toast.error("Couldn't cancel order", {
          description: err instanceof Error ? err.message : "Unknown error — try again.",
        });
      });
    },
    [cancelOrder],
  );

  const handleApproveSettlement = useCallback(
    (orderId: string, quoteId: string) => {
      setApproving(orderId);
      settleWithProtocol(orderId, quoteId)
        .then(() => {
          toast.success("Settlement approved", {
            description: "Your on-chain settleWithProtocol transaction was submitted.",
          });
        })
        .catch((err: unknown) => {
          toast.error("Couldn't approve settlement", {
            description: err instanceof Error ? err.message : "Unknown error — try again.",
          });
        })
        .finally(() => setApproving((current) => (current === orderId ? null : current)));
    },
    [settleWithProtocol],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return orders
      .filter((o) => TABS[tab].statuses.includes(o.status))
      .filter(
        (o) =>
          !q ||
          o.pair.toLowerCase().includes(q) ||
          o.id.toLowerCase().includes(q),
      )
      .sort((a, b) => b.createdAt - a.createdAt);
  }, [orders, tab, query]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, pageCount);
  const rows = filtered.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);

  const summary = useMemo(() => {
    const startOfDay = new Date().setHours(0, 0, 0, 0);
    const open = orders.filter((o) =>
      ["OPEN", "MATCHED", "SETTLING"].includes(o.status),
    ).length;
    const filledToday = orders.filter(
      (o) => o.status === "FILLED" && o.createdAt >= startOfDay,
    ).length;
    const volume = orders
      .filter((o) => o.status === "FILLED")
      .reduce((sum, o) => sum + Number(o.amount) * Number(o.price), 0);
    return [
      { label: "Open Orders", value: String(open) },
      { label: "Filled Today", value: String(filledToday) },
      { label: "Locked Balance", value: `${formatAmount(Number(balanceFor("tNIGHT")) / 1e6)} tNIGHT` },
      { label: "Total Volume", value: formatAmount(volume) },
    ];
  }, [orders, balanceFor]);

  function exportCsv() {
    const blob = new Blob([toCsv(filtered)], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "zekura-orders.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <PageShell
      title="My Orders"
      description="Your confidential open orders and settlement history."
      actions={
        <div className="flex flex-wrap gap-2">
          <div className="flex h-9 w-56 items-center gap-2 rounded-md border border-border px-3 text-sm">
            <Search className="size-3.5 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(1);
              }}
              placeholder="Search orders…"
              className="w-full bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>
          <button
            onClick={exportCsv}
            className="flex h-9 items-center gap-1.5 rounded-md border border-border px-3 text-sm text-foreground/90 transition-colors hover:border-border-hover"
          >
            <Download className="size-3.5" /> Export
          </button>
        </div>
      }
    >
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div>
          <div className="mb-4 flex gap-6 border-b border-border">
            {TABS.map((t, i) => (
              <button
                key={t.label}
                onClick={() => {
                  setTab(i);
                  setPage(1);
                }}
                className={cn(
                  "-mb-px border-b-2 pb-2.5 pt-1 text-sm transition-colors",
                  i === tab
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>

          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead>
                  <tr className="border-b border-border bg-white/[0.02] text-xs text-muted-foreground">
                    <th className="px-3 py-2.5 font-medium">Pair</th>
                    <th className="px-3 py-2.5 font-medium">Side</th>
                    <th className="px-3 py-2.5 font-medium">Limit Price</th>
                    <th className="px-3 py-2.5 font-medium">Amount</th>
                    <th className="px-3 py-2.5 font-medium">Filled %</th>
                    <th className="px-3 py-2.5 font-medium">Status</th>
                    <th className="px-3 py-2.5 font-medium">Created</th>
                    <th className="px-3 py-2.5 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    Array.from({ length: 3 }, (_, i) => (
                      <tr key={i} className="border-b border-border/60 last:border-0">
                        <td colSpan={8} className="px-3 py-3">
                          <Skeleton className="h-5 w-full" />
                        </td>
                      </tr>
                    ))
                  ) : rows.length === 0 ? (
                    <tr>
                      <td
                        colSpan={8}
                        className="py-14 text-center text-sm text-muted-foreground"
                      >
                        No orders here yet.
                      </td>
                    </tr>
                  ) : (
                    rows.map((o) => (
                      <tr
                        key={o.id}
                        className="border-b border-border/60 last:border-0"
                      >
                        <td className="px-3 py-3 text-foreground/90">
                          {o.pair}
                          <span className="ml-1.5 font-mono text-[11px] text-muted-foreground">
                            {formatOrderId(o.id)}
                          </span>
                        </td>
                        <td
                          className={cn(
                            "px-3 py-3 font-medium",
                            o.side === "BUY"
                              ? "text-foreground"
                              : "text-foreground/70",
                          )}
                        >
                          {o.side === "BUY" ? "Buy" : "Sell"}
                        </td>
                        <td className="px-3 py-3 font-mono tabular-nums text-foreground/90">
                          {formatPrice(o.price)}
                        </td>
                        <td className="px-3 py-3 font-mono tabular-nums text-foreground/90">
                          {formatAmount(o.amount)}
                        </td>
                        <td className="px-3 py-3 font-mono tabular-nums text-muted-foreground">
                          {filledPercent(o.status)}%
                        </td>
                        <td className="px-3 py-3">
                          <OrderStatusBadge status={o.status} />
                        </td>
                        <td className="px-3 py-3 font-mono text-xs tabular-nums text-muted-foreground">
                          {formatRelativeTime(o.createdAt)}
                        </td>
                        <td className="px-3 py-3 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            {o.status === "OPEN" && pendingByOrderId.has(o.id) && (
                              <button
                                onClick={() => {
                                  const pending = pendingByOrderId.get(o.id)!;
                                  handleApproveSettlement(o.id, pending.quoteId);
                                }}
                                disabled={approving === o.id}
                                title="Protocol liquidity is reserved for this order — approve to finish the on-chain settlement from your own wallet."
                                className="flex h-7 items-center gap-1 rounded-md border border-primary/40 bg-primary/10 px-2 text-xs font-medium text-foreground transition-colors hover:border-primary/60 disabled:opacity-50"
                              >
                                <Check className="size-3.5" />
                                {approving === o.id ? "Approving…" : "Approve Settlement"}
                              </button>
                            )}
                            {o.status === "OPEN" && (
                              <button
                                onClick={() => handleCancel(o.id)}
                                aria-label="Cancel order"
                                className="rounded p-1 text-muted-foreground transition-colors hover:bg-white/[0.05] hover:text-foreground"
                              >
                                <X className="size-4" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </Card>

          <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
            <span>
              {filtered.length === 0
                ? "No results"
                : `Showing ${(current - 1) * PAGE_SIZE + 1}–${
                    (current - 1) * PAGE_SIZE + rows.length
                  } of ${filtered.length}`}
            </span>
            {pageCount > 1 && (
              <div className="flex gap-1.5">
                <PageBtn label="‹" onClick={() => setPage(current - 1)} disabled={current === 1} />
                {Array.from({ length: pageCount }, (_, i) => (
                  <PageBtn
                    key={i}
                    label={String(i + 1)}
                    active={current === i + 1}
                    onClick={() => setPage(i + 1)}
                  />
                ))}
                <PageBtn
                  label="›"
                  onClick={() => setPage(current + 1)}
                  disabled={current === pageCount}
                />
              </div>
            )}
          </div>
        </div>

        <Card className="h-fit p-5">
          <div className="mb-4 text-xs font-semibold tracking-wide text-muted-foreground">
            SUMMARY
          </div>
          <div className="flex flex-col gap-5">
            {summary.map((s) => (
              <div key={s.label}>
                <div className="text-xs text-muted-foreground">{s.label}</div>
                <div className="mt-1 font-mono text-xl tabular-nums text-foreground">
                  {s.value}
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </PageShell>
  );
}

function PageBtn({
  label,
  onClick,
  active,
  disabled,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex size-7 items-center justify-center rounded-md border text-xs transition-colors disabled:opacity-40",
        active
          ? "border-primary/50 bg-primary/10 text-foreground"
          : "border-border text-muted-foreground hover:border-border-hover",
      )}
    >
      {label}
    </button>
  );
}
