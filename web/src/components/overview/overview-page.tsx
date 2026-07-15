"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Activity,
  ArrowUpRight,
  Copy,
  Lock,
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
  formatPercent,
  formatPrice,
  formatRelativeTime,
  truncateAddress,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ActivityEvent, Order } from "@/lib/types";

const MID_PRICES: Record<string, number> = {
  "tDUST/tUSD": 0.84,
  "tNIGHT/tUSD": 1.62,
};

// Illustrative 30-day portfolio series (demo — the contract is a commitment
// registry only, so there is no real balance history to chart yet).
const PORTFOLIO_SERIES = [
  118, 121, 119, 124, 122, 128, 131, 129, 134, 138, 136, 141, 139, 145, 148,
  144, 150, 153, 149, 156, 159, 155, 162, 166, 163, 169, 172, 168, 175, 181,
];

const ALLOCATION = [
  { label: "tNIGHT", weight: 0.46, color: "var(--chart-1)" },
  { label: "tUSD", weight: 0.32, color: "var(--chart-3)" },
  { label: "tDUST", weight: 0.22, color: "var(--chart-4)" },
];

const ACTIVITY_LABEL: Record<ActivityEvent["kind"], string> = {
  ORDER_CREATED: "Order created",
  ORDER_MATCHED: "Order matched",
  SETTLEMENT_STARTED: "Settlement started",
  ORDER_FILLED: "Order filled",
  ORDER_CANCELLED: "Order cancelled",
  ORDER_EXPIRED: "Order expired",
  ORDER_FAILED: "Order failed",
};

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

function PortfolioChart() {
  const min = Math.min(...PORTFOLIO_SERIES);
  const max = Math.max(...PORTFOLIO_SERIES);
  const w = 600;
  const h = 220;
  const points = PORTFOLIO_SERIES.map((v, i) => {
    const x = (i / (PORTFOLIO_SERIES.length - 1)) * w;
    const y = h - ((v - min) / (max - min || 1)) * (h - 20) - 10;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const area = `0,${h} ${points.join(" ")} ${w},${h}`;

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="block h-[220px] w-full"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="pfArea" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--chart-1)" stopOpacity="0.25" />
          <stop offset="100%" stopColor="var(--chart-1)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[55, 110, 165].map((y) => (
        <line key={y} x1="0" y1={y} x2={w} y2={y} stroke="var(--border)" />
      ))}
      <polygon points={area} fill="url(#pfArea)" />
      <polyline
        points={points.join(" ")}
        fill="none"
        stroke="var(--chart-1)"
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function AllocationDonut() {
  const r = 50;
  const c = 2 * Math.PI * r;
  const offsets = ALLOCATION.reduce<number[]>(
    (acc, a, i) => [...acc, (acc[i] ?? 0) + a.weight * c],
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
        {ALLOCATION.map((a, i) => {
          const len = a.weight * c;
          return (
            <circle
              key={a.label}
              cx="60"
              cy="60"
              r={r}
              fill="none"
              stroke={a.color}
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
  const portfolioValue = PORTFOLIO_SERIES[PORTFOLIO_SERIES.length - 1] * 1000;
  const change24h =
    ((PORTFOLIO_SERIES[PORTFOLIO_SERIES.length - 1] -
      PORTFOLIO_SERIES[PORTFOLIO_SERIES.length - 2]) /
      PORTFOLIO_SERIES[PORTFOLIO_SERIES.length - 2]) *
    100;

  const openOrders = useMemo(
    () => orders.filter((o) => ["OPEN", "MATCHED", "SETTLING"].includes(o.status)),
    [orders],
  );

  const markets = useMemo(
    () =>
      ASSET_PAIRS.map((p, i) => {
        const label = `${p.base}/${p.quote}`;
        return {
          label,
          price: MID_PRICES[label] ?? 1,
          change: [2.1, -1.4, 4.8, 0.6][i % 4],
        };
      }),
    [],
  );
  const movers = useMemo(
    () => [...markets].sort((a, b) => Math.abs(b.change) - Math.abs(a.change)),
    [markets],
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
            label="Portfolio Value"
            value={`$${formatAmount(portfolioValue)}`}
            sub={`${formatPercent(change24h)} · 24h`}
            subClass={change24h >= 0 ? "text-primary" : "text-destructive"}
          />
          <KpiCard
            icon={<Wallet className="size-3.5" />}
            label="Available Balance"
            value={`${formatAmount(nightBalance)} tNIGHT`}
            sub={wallet ? "Unshielded" : "Connect wallet"}
          />
          <KpiCard
            icon={<Lock className="size-3.5" />}
            label="Locked / Staked"
            value="0.00 tNIGHT"
            sub="No active locks"
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

        {/* Chart + Allocation */}
        <div className="mb-8 grid grid-cols-1 gap-4 lg:grid-cols-[2fr_1fr]">
          <Card>
            <div className="mb-4 flex items-center justify-between">
              <SectionTitle>Portfolio Value</SectionTitle>
              <div className="flex gap-1.5">
                {["7D", "30D", "90D"].map((t, i) => (
                  <button
                    key={t}
                    className={cn(
                      "rounded-md border px-2 py-1 text-xs transition-colors",
                      i === 1
                        ? "border-primary/50 bg-primary/10 text-foreground"
                        : "border-border text-muted-foreground hover:border-border-hover",
                    )}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
            <PortfolioChart />
          </Card>

          <Card className="flex flex-col">
            <SectionTitle>Asset Allocation</SectionTitle>
            <AllocationDonut />
            <div className="mt-4 flex flex-col gap-2">
              {ALLOCATION.map((a) => (
                <div
                  key={a.label}
                  className="flex items-center justify-between text-xs"
                >
                  <span className="flex items-center gap-2 text-muted-foreground">
                    <span
                      className="size-2 rounded-full"
                      style={{ background: a.color }}
                    />
                    {a.label}
                  </span>
                  <span className="font-mono tabular-nums text-foreground/80">
                    {Math.round(a.weight * 100)}%
                  </span>
                </div>
              ))}
            </div>
          </Card>
        </div>

        {/* Orders + Activity */}
        <div className="mb-8 grid grid-cols-1 gap-4 lg:grid-cols-[2fr_1fr]">
          <Card>
            <div className="mb-4 flex items-center justify-between">
              <SectionTitle>Open Orders</SectionTitle>
              <Link
                href="/"
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

        {/* Market + Quick Actions */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[2fr_1fr]">
          <Card>
            <SectionTitle>Markets</SectionTitle>
            <div className="mt-4 grid grid-cols-1 gap-6 sm:grid-cols-2">
              <div>
                <p className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
                  Watchlist
                </p>
                {markets.map((m) => (
                  <div
                    key={m.label}
                    className="flex items-center justify-between border-b border-border/60 py-2 text-sm last:border-0"
                  >
                    <span className="text-foreground/90">{m.label}</span>
                    <span className="font-mono tabular-nums text-foreground/80">
                      {formatPrice(m.price)}
                    </span>
                  </div>
                ))}
              </div>
              <div>
                <p className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
                  Top Movers
                </p>
                {movers.map((m) => (
                  <div
                    key={m.label}
                    className="flex items-center justify-between border-b border-border/60 py-2 text-sm last:border-0"
                  >
                    <span className="text-foreground/90">{m.label}</span>
                    <span
                      className={cn(
                        "font-mono tabular-nums",
                        m.change >= 0 ? "text-primary" : "text-destructive",
                      )}
                    >
                      {formatPercent(m.change)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </Card>

          <Card>
            <SectionTitle>Quick Actions</SectionTitle>
            <div className="mt-4 flex flex-col gap-3">
              <Link
                href="/"
                className="flex items-center justify-center gap-1.5 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
              >
                New Trade <ArrowUpRight className="size-4" />
              </Link>
              <Link
                href="/"
                className="rounded-md border border-border px-4 py-2.5 text-center text-sm font-medium text-foreground/90 transition-colors hover:border-border-hover"
              >
                My Orders
              </Link>
              <button
                disabled
                className="cursor-not-allowed rounded-md border border-border px-4 py-2.5 text-center text-sm font-medium text-muted-foreground opacity-50"
              >
                Stake (soon)
              </button>
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
