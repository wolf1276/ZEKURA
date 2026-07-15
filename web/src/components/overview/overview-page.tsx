"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { unshieldedToken } from "@midnight-ntwrk/ledger-v8";
import {
  Activity,
  ArrowUpRight,
  Copy,
  ListChecks,
  Radio,
  Wallet,
} from "lucide-react";
import { toast } from "sonner";
import { Navbar } from "@/components/layout/navbar";
import { Footer } from "@/components/layout/footer";
import { OrderStatusBadge } from "@/components/trade/order-status-badge";
import { useWallet } from "@/wallet/walletHooks";
import { matcher } from "@/services/matcher/matcherClient";
import { ASSET_PAIRS } from "@/lib/mock/market";
import {
  formatAmount,
  formatOrderId,
  formatPrice,
  formatRelativeTime,
  truncateAddress,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ActivityEvent, Order } from "@/lib/types";

/** Native NIGHT token key in unshieldedBalances — every other key is a raw asset id we have no symbol for. */
const NATIVE_TOKEN = unshieldedToken().raw;
const CHART_COLORS = [
  "var(--chart-1)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-2)",
  "var(--chart-5)",
];

const OPEN_STATUSES = ["OPEN", "MATCHED", "SETTLING"];

const ACTIVITY_LABEL: Record<ActivityEvent["kind"], string> = {
  ORDER_CREATED: "Order created",
  ORDER_MATCHED: "Order matched",
  SETTLEMENT_STARTED: "Settlement started",
  ORDER_FILLED: "Order filled",
  ORDER_CANCELLED: "Order cancelled",
  ORDER_EXPIRED: "Order expired",
  ORDER_FAILED: "Order failed",
};

function tokenLabel(key: string): string {
  return key === NATIVE_TOKEN ? "tNIGHT" : `${key.slice(0, 6)}…`;
}

function Card({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-card p-5 transition-colors hover:border-border-hover",
        className,
      )}
    >
      {children}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-sm font-semibold tracking-tight text-foreground">
      {children}
    </h2>
  );
}

function KpiCard({
  label,
  value,
  sub,
  subClass,
  icon,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  subClass?: string;
  icon: React.ReactNode;
}) {
  return (
    <Card>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="mt-4 truncate font-mono text-xl tabular-nums text-foreground">
        {value}
      </div>
      {sub && (
        <div className={cn("mt-2 text-xs text-muted-foreground", subClass)}>
          {sub}
        </div>
      )}
    </Card>
  );
}

interface Holding {
  label: string;
  amount: number;
  weight: number;
  color: string;
}

function AllocationDonut({ holdings }: { holdings: Holding[] }) {
  const r = 50;
  const c = 2 * Math.PI * r;
  const offsets = holdings.reduce<number[]>(
    (acc, h, i) => [...acc, (acc[i] ?? 0) + h.weight * c],
    [0],
  );
  return (
    <div className="flex flex-1 items-center justify-center">
      <svg viewBox="0 0 120 120" className="size-36 -rotate-90">
        <circle
          cx="60"
          cy="60"
          r={r}
          fill="none"
          stroke="var(--border)"
          strokeWidth="16"
        />
        {holdings.map((h, i) => {
          const len = h.weight * c;
          return (
            <circle
              key={h.label}
              cx="60"
              cy="60"
              r={r}
              fill="none"
              stroke={h.color}
              strokeWidth="16"
              strokeDasharray={`${len} ${c - len}`}
              strokeDashoffset={-offsets[i]}
            />
          );
        })}
      </svg>
    </div>
  );
}

export function OverviewPage() {
  const { status, wallet, balanceFor } = useWallet();
  const [orders, setOrders] = useState<Order[]>([]);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);

  useEffect(() => matcher.subscribe(setOrders), []);
  useEffect(
    () =>
      matcher.subscribeActivity((e) =>
        setActivity((prev) => [e, ...prev].slice(0, 6)),
      ),
    [],
  );

  const nightBalance = Number(balanceFor("tNIGHT")) / 1e6;

  // Real holdings from the wallet's unshielded balances (native NIGHT is the
  // only symbol we can name — see useWallet's note; other keys show truncated).
  const holdings = useMemo<Holding[]>(() => {
    const entries = Object.entries(wallet?.unshieldedBalances ?? {})
      .map(([key, bal]) => ({ label: tokenLabel(key), amount: Number(bal) / 1e6 }))
      .filter((h) => h.amount > 0)
      .sort((a, b) => b.amount - a.amount);
    const total = entries.reduce((s, h) => s + h.amount, 0);
    return entries.map((h, i) => ({
      ...h,
      weight: total > 0 ? h.amount / total : 0,
      color: CHART_COLORS[i % CHART_COLORS.length],
    }));
  }, [wallet]);

  const openOrders = useMemo(
    () => orders.filter((o) => OPEN_STATUSES.includes(o.status)),
    [orders],
  );
  const filledCount = useMemo(
    () => orders.filter((o) => o.status === "FILLED").length,
    [orders],
  );

  // "Markets" derived from real order flow: last-seen price and current open
  // interest per pair. No external price feed exists, so a pair with no orders
  // yet honestly shows no price rather than a made-up one.
  const markets = useMemo(
    () =>
      ASSET_PAIRS.map((p) => {
        const label = `${p.base}/${p.quote}`;
        const pairOrders = orders
          .filter((o) => o.pair === label)
          .sort((a, b) => b.createdAt - a.createdAt);
        const last =
          pairOrders.find((o) => o.status === "FILLED") ?? pairOrders[0];
        return {
          label,
          price: last ? Number(last.price) : null,
          openInterest: pairOrders.filter((o) =>
            OPEN_STATUSES.includes(o.status),
          ).length,
        };
      }),
    [orders],
  );

  const networkOnline = status === "connected";

  async function copyAddress() {
    if (!wallet) return;
    await navigator.clipboard.writeText(wallet.unshieldedAddress);
    toast.success("Address copied");
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <Navbar />
      <main className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-8 md:px-8">
        {/* Title */}
        <div className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Overview
          </h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Your confidential portfolio, orders, and market activity at a glance.
          </p>
        </div>

        {/* KPIs */}
        <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <KpiCard
            icon={<Wallet className="size-3.5" />}
            label="Available Balance"
            value={`${formatAmount(nightBalance)} tNIGHT`}
            sub={wallet ? "Unshielded · native NIGHT" : "Connect wallet"}
          />
          <KpiCard
            icon={<ListChecks className="size-3.5" />}
            label="Open Orders"
            value={String(openOrders.length)}
            sub={`${orders.length} total`}
          />
          <KpiCard
            icon={<ListChecks className="size-3.5" />}
            label="Filled Orders"
            value={String(filledCount)}
            sub="Settled on-chain"
          />
          <KpiCard
            icon={<Radio className="size-3.5" />}
            label="Network Status"
            value={
              <span className="flex items-center gap-2 text-base">
                <span
                  className={cn(
                    "size-2 rounded-full",
                    networkOnline ? "bg-primary" : "bg-muted-foreground",
                  )}
                />
                {networkOnline ? "Online" : "Offline"}
              </span>
            }
            sub={wallet?.networkId ?? "—"}
          />
          <KpiCard
            icon={<Wallet className="size-3.5" />}
            label="Wallet Address"
            value={
              <span className="text-base">
                {wallet ? truncateAddress(wallet.unshieldedAddress, 8, 6) : "—"}
              </span>
            }
            sub={
              wallet ? (
                <button
                  onClick={copyAddress}
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  <Copy className="size-3" /> Copy
                </button>
              ) : (
                "Not connected"
              )
            }
          />
        </div>

        {/* Holdings + Allocation */}
        <div className="mb-8 grid grid-cols-1 gap-4 lg:grid-cols-[2fr_1fr]">
          <Card>
            <SectionTitle>Holdings</SectionTitle>
            <div className="mt-4">
              {holdings.length === 0 ? (
                <p className="py-12 text-center text-sm text-muted-foreground">
                  {wallet
                    ? "No unshielded token balances."
                    : "Connect your wallet to see holdings."}
                </p>
              ) : (
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-border text-xs text-muted-foreground">
                      <th className="py-2 pr-4 font-medium">Token</th>
                      <th className="py-2 pr-4 font-medium">Balance</th>
                      <th className="py-2 pr-2 font-medium">Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {holdings.map((h) => (
                      <tr
                        key={h.label}
                        className="border-b border-border/60 last:border-0"
                      >
                        <td className="py-2.5 pr-4">
                          <span className="flex items-center gap-2 text-foreground/90">
                            <span
                              className="size-2 rounded-full"
                              style={{ background: h.color }}
                            />
                            {h.label}
                          </span>
                        </td>
                        <td className="py-2.5 pr-4 font-mono tabular-nums text-foreground/90">
                          {formatAmount(h.amount)}
                        </td>
                        <td className="py-2.5 pr-2 font-mono tabular-nums text-muted-foreground">
                          {Math.round(h.weight * 100)}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </Card>

          <Card className="flex flex-col">
            <SectionTitle>Asset Allocation</SectionTitle>
            {holdings.length === 0 ? (
              <p className="flex flex-1 items-center justify-center py-12 text-center text-sm text-muted-foreground">
                No allocation to show yet.
              </p>
            ) : (
              <>
                <AllocationDonut holdings={holdings} />
                <div className="mt-4 flex flex-col gap-2">
                  {holdings.map((h) => (
                    <div
                      key={h.label}
                      className="flex items-center justify-between text-xs"
                    >
                      <span className="flex items-center gap-2 text-muted-foreground">
                        <span
                          className="size-2 rounded-full"
                          style={{ background: h.color }}
                        />
                        {h.label}
                      </span>
                      <span className="font-mono tabular-nums text-foreground/80">
                        {Math.round(h.weight * 100)}%
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </Card>
        </div>

        {/* Orders + Activity */}
        <div className="mb-8 grid grid-cols-1 gap-4 lg:grid-cols-[2fr_1fr]">
          <Card>
            <div className="mb-4 flex items-center justify-between">
              <SectionTitle>Open Orders</SectionTitle>
              <Link
                href="/orders"
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                View all
              </Link>
            </div>
            {openOrders.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                No open orders yet.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[520px] text-left text-sm">
                  <thead>
                    <tr className="border-b border-border text-xs text-muted-foreground">
                      <th className="py-2 pr-4 font-medium">Order</th>
                      <th className="py-2 pr-4 font-medium">Asset</th>
                      <th className="py-2 pr-4 font-medium">Side</th>
                      <th className="py-2 pr-4 font-medium">Amount</th>
                      <th className="py-2 pr-2 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {openOrders.slice(0, 5).map((o) => (
                      <tr
                        key={o.id}
                        className="border-b border-border/60 last:border-0"
                      >
                        <td className="py-2.5 pr-4 font-mono text-xs text-foreground/80">
                          {formatOrderId(o.id)}
                        </td>
                        <td className="py-2.5 pr-4 text-foreground/90">{o.pair}</td>
                        <td
                          className={cn(
                            "py-2.5 pr-4 font-medium",
                            o.side === "BUY"
                              ? "text-foreground"
                              : "text-foreground/70",
                          )}
                        >
                          {o.side === "BUY" ? "Buy" : "Sell"}
                        </td>
                        <td className="py-2.5 pr-4 font-mono tabular-nums text-foreground/90">
                          {formatAmount(o.amount)}
                        </td>
                        <td className="py-2.5 pr-2">
                          <OrderStatusBadge status={o.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card>
            <SectionTitle>Recent Activity</SectionTitle>
            <div className="mt-4">
              {activity.length === 0 ? (
                <p className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
                  <Activity className="size-4" /> Waiting for live events…
                </p>
              ) : (
                activity.map((e) => (
                  <div key={e.id} className="flex gap-3 py-2.5">
                    <span className="mt-1.5 size-2 flex-none rounded-full bg-primary" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-foreground/90">
                        {ACTIVITY_LABEL[e.kind]} · {e.pair}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {formatRelativeTime(e.timestamp)}
                      </p>
                    </div>
                  </div>
                ))
              )}
            </div>
          </Card>
        </div>

        {/* Markets + Quick Actions */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[2fr_1fr]">
          <Card>
            <SectionTitle>Markets</SectionTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              Last price and open interest from live order flow.
            </p>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[420px] text-left text-sm">
                <thead>
                  <tr className="border-b border-border text-xs text-muted-foreground">
                    <th className="py-2 pr-4 font-medium">Pair</th>
                    <th className="py-2 pr-4 font-medium">Last Price</th>
                    <th className="py-2 pr-2 font-medium">Open Interest</th>
                  </tr>
                </thead>
                <tbody>
                  {markets.map((m) => (
                    <tr
                      key={m.label}
                      className="border-b border-border/60 last:border-0"
                    >
                      <td className="py-2.5 pr-4 text-foreground/90">{m.label}</td>
                      <td className="py-2.5 pr-4 font-mono tabular-nums text-foreground/80">
                        {m.price === null ? "—" : formatPrice(m.price)}
                      </td>
                      <td className="py-2.5 pr-2 font-mono tabular-nums text-muted-foreground">
                        {m.openInterest}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card>
            <SectionTitle>Quick Actions</SectionTitle>
            <div className="mt-4 flex flex-col gap-3">
              <Link
                href="/trade"
                className="flex items-center justify-center gap-1.5 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
              >
                New Trade <ArrowUpRight className="size-4" />
              </Link>
              <Link
                href="/orders"
                className="rounded-md border border-border px-4 py-2.5 text-center text-sm font-medium text-foreground/90 transition-colors hover:border-border-hover"
              >
                My Orders
              </Link>
              <Link
                href="/activity"
                className="rounded-md border border-border px-4 py-2.5 text-center text-sm font-medium text-foreground/90 transition-colors hover:border-border-hover"
              >
                Activity
              </Link>
              <button
                onClick={copyAddress}
                disabled={!wallet}
                className="rounded-md border border-border px-4 py-2.5 text-center text-sm font-medium text-foreground/90 transition-colors hover:border-border-hover disabled:opacity-50"
              >
                Receive / Deposit
              </button>
            </div>
          </Card>
        </div>
      </main>
      <Footer />
    </div>
  );
}
