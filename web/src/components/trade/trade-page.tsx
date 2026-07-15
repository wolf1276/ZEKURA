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
import { DEFAULT_PAIR } from "@/lib/mock/market";
import { deriveMarketInsights } from "@/lib/marketInsights";
import { useMarketData } from "@/hooks/use-market-data";
import { matcher } from "@/services/matcher/matcherClient";
import type { AssetPair, MarketInsights, Order } from "@/lib/types";

// Used only until the market has any real trade/quote data for a pair (a
// cold-start book with no resting orders and no trade history yet) — once
// useMarketData reports a real lastPrice or a best bid/ask, that always
// wins. Never shown as a live/traded price; the chart's own footer already
// discloses "Reference price line — oracle feed, not an order book".
const FALLBACK_MID_PRICES: Record<string, number> = {
  "tDUST-tUSD": 0.84,
  "tNIGHT-tUSD": 1.62,
};

const DEFAULT_INSIGHTS: MarketInsights = {
  suggestedBuy: { low: 0, high: 0 },
  suggestedSell: { low: 0, high: 0 },
  liquidityZones: {
    strong: { low: 0, high: 0 },
    moderate: { low: 0, high: 0 },
    emerging: { low: 0, high: 0 },
  },
  activityLevel: "Low",
  volatility: "Low",
  estimatedSettlementSeconds: { low: 30, high: 90 },
};

export function TradePage() {
  const [pair, setPair] = useState<AssetPair>(DEFAULT_PAIR);
  const [orders, setOrders] = useState<Order[]>([]);
  const [trackedOrderId, setTrackedOrderId] = useState<string | null>(null);
  const marketData = useMarketData(pair);

  useEffect(() => matcher.subscribe(setOrders), []);

  const midPrice = useMemo(() => {
    const lastPrice = marketData.stats?.lastPrice ? Number(marketData.stats.lastPrice) : null;
    if (lastPrice) return lastPrice;
    const bestBid = marketData.orderBook?.bids[0] ? Number(marketData.orderBook.bids[0].price) : null;
    const bestAsk = marketData.orderBook?.asks[0] ? Number(marketData.orderBook.asks[0].price) : null;
    if (bestBid !== null && bestAsk !== null) return (bestBid + bestAsk) / 2;
    return bestBid ?? bestAsk ?? FALLBACK_MID_PRICES[pair.id] ?? 1;
  }, [marketData.stats, marketData.orderBook, pair.id]);

  const change24h = marketData.stats?.changePct ?? 0;

  const insights = useMemo(
    () => (marketData.orderBook && marketData.stats ? deriveMarketInsights(marketData.orderBook, marketData.stats) : DEFAULT_INSIGHTS),
    [marketData.orderBook, marketData.stats],
  );
  const trackedOrder = orders.find((o) => o.id === trackedOrderId) ?? null;

  const handleOrderCreated = useCallback((order: Order) => {
    setTrackedOrderId(order.id);
  }, []);

  const handleCancel = useCallback((id: string) => {
    void matcher.cancelOrder(id);
  }, []);

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <Navbar />
      <MarketHeader
        pair={pair}
        onPairChange={setPair}
        midPrice={midPrice}
        change24h={change24h}
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
