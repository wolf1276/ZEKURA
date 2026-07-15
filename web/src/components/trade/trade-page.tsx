"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Navbar } from "@/components/layout/navbar";
import { Footer } from "@/components/layout/footer";
import { MarketHeader } from "@/components/trade/market-header";
import { TradingChart } from "@/components/trade/trading-chart";
import { MarketInsightsPanel } from "@/components/trade/market-insights";
import { TradePanel } from "@/components/trade/trade-panel";
import { RecentOrders } from "@/components/trade/recent-orders";
import { OrderStatusTimeline } from "@/components/trade/order-status-timeline";
import { DEFAULT_PAIR, getMarketInsights } from "@/lib/mock/market";
import { mockMatcher } from "@/lib/mock/matcher";
import type { AssetPair, Order } from "@/lib/types";

const MID_PRICES: Record<string, number> = {
  "tDUST-tUSD": 0.84,
  "tNIGHT-tUSD": 1.62,
};

export function TradePage() {
  const [pair, setPair] = useState<AssetPair>(DEFAULT_PAIR);
  const [orders, setOrders] = useState<Order[]>([]);
  const [trackedOrderId, setTrackedOrderId] = useState<string | null>(null);

  useEffect(() => mockMatcher.subscribe(setOrders), []);

  const midPrice = MID_PRICES[pair.id] ?? 1;
  const insights = useMemo(() => getMarketInsights(midPrice), [midPrice]);
  const trackedOrder = orders.find((o) => o.id === trackedOrderId) ?? null;

  const handleOrderCreated = useCallback((order: Order) => {
    setTrackedOrderId(order.id);
  }, []);

  const handleCancel = useCallback((id: string) => {
    mockMatcher.cancelOrder(id);
  }, []);

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <Navbar />
      <MarketHeader
        pair={pair}
        onPairChange={setPair}
        midPrice={midPrice}
        change24h={2.1}
        volatility={insights.volatility}
        activityLevel={insights.activityLevel}
      />

      <main className="flex flex-1 flex-col">
        <div className="grid flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] xl:grid-cols-[minmax(0,1fr)_320px_360px]">
          <div className="min-h-[480px] border-b border-border lg:col-span-2 lg:border-b-0 lg:border-r xl:col-span-1">
            <TradingChart
              pairLabel={`${pair.base}/${pair.quote}`}
              basePrice={midPrice}
            />
          </div>
          <div className="border-b border-border lg:border-b-0 lg:border-r">
            <MarketInsightsPanel insights={insights} quoteSymbol={pair.quote} />
          </div>
          <div>
            <TradePanel
              pair={pair}
              onPairChange={setPair}
              midPrice={midPrice}
              onOrderCreated={handleOrderCreated}
            />
          </div>
        </div>

        <div className="border-t border-border">
          <RecentOrders orders={orders} onCancel={handleCancel} />
        </div>

        {trackedOrder && (
          <div className="border-t border-border p-4 md:p-5">
            <p className="mb-3 text-xs uppercase tracking-wide text-muted-foreground">
              Order status timeline
            </p>
            <OrderStatusTimeline key={trackedOrder.id} order={trackedOrder} />
          </div>
        )}
      </main>

      <Footer />
    </div>
  );
}
