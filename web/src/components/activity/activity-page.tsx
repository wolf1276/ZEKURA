"use client";

import { useEffect, useMemo, useState } from "react";
import { Activity, Search } from "lucide-react";
import { PageShell, Card } from "@/components/layout/page-shell";
import { useWallet } from "@/wallet/walletHooks";
import { matcher, fetchTreasuryActivityBackfill } from "@/services/matcher/matcherClient";
import { formatOrderId, formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ActivityEvent, ActivityKind } from "@/lib/types";

const LABEL: Record<ActivityKind, string> = {
  ORDER_CREATED: "Order Submitted",
  ORDER_MATCHED: "Order Matched",
  SETTLEMENT_STARTED: "Settlement Started",
  ORDER_FILLED: "Settlement Completed",
  ORDER_CANCELLED: "Order Cancelled",
  ORDER_EXPIRED: "Order Expired",
  ORDER_FAILED: "Order Failed",
  TREASURY_DEPOSITED: "Treasury Deposit",
  TREASURY_WITHDRAWN: "Treasury Withdrawal",
  TREASURY_RESERVED: "Liquidity Reserved",
  TREASURY_RELEASED: "Liquidity Released",
  TREASURY_EXECUTED: "Protocol Fill Executed",
};

const STATUS: Record<ActivityKind, { label: string; className: string }> = {
  ORDER_CREATED: { label: "Pending", className: "text-muted-foreground" },
  ORDER_MATCHED: { label: "Success", className: "text-primary" },
  SETTLEMENT_STARTED: { label: "Pending", className: "text-muted-foreground" },
  ORDER_FILLED: { label: "Success", className: "text-primary" },
  ORDER_CANCELLED: { label: "Cancelled", className: "text-muted-foreground" },
  ORDER_EXPIRED: { label: "Expired", className: "text-muted-foreground" },
  ORDER_FAILED: { label: "Failed", className: "text-destructive" },
  TREASURY_DEPOSITED: { label: "Success", className: "text-primary" },
  TREASURY_WITHDRAWN: { label: "Success", className: "text-primary" },
  TREASURY_RESERVED: { label: "Pending", className: "text-muted-foreground" },
  TREASURY_RELEASED: { label: "Success", className: "text-primary" },
  TREASURY_EXECUTED: { label: "Success", className: "text-primary" },
};

const TREASURY_KINDS: ReadonlySet<ActivityKind> = new Set([
  "TREASURY_DEPOSITED",
  "TREASURY_WITHDRAWN",
  "TREASURY_RESERVED",
  "TREASURY_RELEASED",
  "TREASURY_EXECUTED",
]);

export function ActivityPage() {
  const { status, wallet } = useWallet();
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetchTreasuryActivityBackfill().then((backfill) => {
      if (!cancelled && backfill.length > 0) {
        setEvents((prev) => [...prev, ...backfill].slice(0, 100));
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(
    () =>
      matcher.subscribeActivity((e) =>
        setEvents((prev) => [e, ...prev].slice(0, 100)),
      ),
    [],
  );

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return events;
    return events.filter(
      (e) =>
        (e.pair ?? "").toLowerCase().includes(q) ||
        LABEL[e.kind].toLowerCase().includes(q),
    );
  }, [events, query]);

  const online = status === "connected";
  const systemStatuses = [
    { label: "Current Network", value: wallet?.networkId ?? "—", ok: !!wallet },
    { label: "Wallet Status", value: online ? "Connected" : "Disconnected", ok: online },
    { label: "Matcher Status", value: online ? "Online" : "Offline", ok: online },
    { label: "Exchange Status", value: online ? "Online" : "Offline", ok: online },
  ];

  return (
    <PageShell
      title="Activity"
      description="A live, confidential feed of your order lifecycle events."
      actions={
        <div className="flex h-9 w-56 items-center gap-2 rounded-md border border-border px-3 text-sm">
          <Search className="size-3.5 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search…"
            className="w-full bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>
      }
    >
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        {/* Timeline */}
        <div className="relative pl-5">
          <div className="absolute inset-y-1 left-[6px] w-px bg-border" />
          {shown.length === 0 ? (
            <Card className="p-5">
              <p className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
                <Activity className="size-4" /> Waiting for live events…
              </p>
            </Card>
          ) : (
            <ul className="flex flex-col gap-4">
              {shown.map((e) => {
                const st = STATUS[e.kind];
                return (
                  <li key={e.id} className="relative pl-4">
                    <span className="absolute -left-[calc(1.25rem-1px)] top-4 size-2.5 -translate-x-1/2 rounded-full border-2 border-primary bg-background" />
                    <Card className="p-4">
                      <div className="mb-2 flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold text-foreground">
                            {LABEL[e.kind]}
                          </span>
                          <span
                            className={cn(
                              "rounded border border-border px-1.5 py-0.5 text-[11px]",
                              st.className,
                            )}
                          >
                            {st.label}
                          </span>
                        </div>
                        <span className="text-xs text-muted-foreground">
                          {formatRelativeTime(e.timestamp)}
                        </span>
                      </div>
                      <p className="text-sm text-foreground/80">
                        {TREASURY_KINDS.has(e.kind)
                          ? `${e.pair} · ${e.amount}`
                          : `${e.pair} · ${e.side === "BUY" ? "Buy" : "Sell"}`}
                      </p>
                      <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                        {e.orderId ? `Order: ${formatOrderId(e.orderId)}` : e.txId ? `Tx: ${formatOrderId(e.txId)}` : null}
                      </p>
                    </Card>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Sidebar */}
        <div className="flex flex-col gap-4">
          <Card className="p-5">
            <div className="mb-3.5 text-xs font-semibold tracking-wide text-muted-foreground">
              RECENT NOTIFICATIONS
            </div>
            {events.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing yet.</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {events.slice(0, 4).map((e) => (
                  <li key={e.id} className="flex items-start gap-2.5">
                    <span className="mt-1.5 size-2 flex-none rounded-full bg-primary" />
                    <p className="text-sm text-foreground/85">
                      {LABEL[e.kind]} · {e.pair}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="p-5">
            <div className="mb-3.5 text-xs font-semibold tracking-wide text-muted-foreground">
              SYSTEM STATUS
            </div>
            <ul className="flex flex-col gap-3">
              {systemStatuses.map((s) => (
                <li
                  key={s.label}
                  className="flex items-center justify-between text-sm"
                >
                  <span className="text-muted-foreground">{s.label}</span>
                  <span className="flex items-center gap-1.5 text-foreground/85">
                    <span
                      className={cn(
                        "size-2 rounded-full",
                        s.ok ? "bg-primary" : "bg-muted-foreground",
                      )}
                    />
                    {s.value}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </PageShell>
  );
}
