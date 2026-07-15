"use client";

import { useEffect, useState } from "react";
import { getOrderBook, getStats, getTrades } from "@/services/matcher/api";
import { matcher } from "@/services/matcher/matcherClient";
import type { AssetPair } from "@/lib/types";
import type {
  MatcherEitherAsset,
  MatcherOrderBookLevel,
  MatcherOrderBookSnapshot,
  MatcherOrderSide,
  MatcherStats,
  MatcherTrade,
} from "@/types/matcher";

const MAX_TRADES = 50;
// Both act as a reconciliation safety net against a missed WS message (e.g.
// a brief disconnect — matcherClient reconnects on its own timer, but a
// message that arrived while offline is simply gone) rather than the
// primary update path, which is the live order.* events below.
const STATS_REFRESH_MS = 30_000;
const ORDERBOOK_REFRESH_MS = 30_000;

export interface MarketDataState {
  orderBook: MatcherOrderBookSnapshot | null;
  trades: MatcherTrade[];
  stats: MatcherStats | null;
  loading: boolean;
  error: string | null;
}

function sameAsset(a: MatcherEitherAsset, b: MatcherEitherAsset): boolean {
  return a.isLeft === b.isLeft && a.left === b.left && a.right === b.right;
}

function applyLevelDelta(
  book: MatcherOrderBookSnapshot,
  side: MatcherOrderSide,
  price: string,
  amount: string,
  sign: 1 | -1,
): MatcherOrderBookSnapshot {
  const key = side === "BUY" ? "bids" : "asks";
  const levels = book[key];
  const idx = levels.findIndex((l) => l.price === price);

  let nextLevels: MatcherOrderBookLevel[];
  if (idx === -1) {
    // Removing a level this session never saw created (e.g. it was already
    // resting before this hook mounted) — the periodic refresh reconciles it.
    if (sign < 0) return book;
    nextLevels = [...levels, { price, amount, orderCount: 1 }];
  } else {
    const existing = levels[idx]!;
    const nextAmount = BigInt(existing.amount) + BigInt(amount) * BigInt(sign);
    const nextCount = existing.orderCount + sign;
    nextLevels =
      nextAmount <= 0n || nextCount <= 0
        ? levels.filter((_, i) => i !== idx)
        : levels.map((l, i) => (i === idx ? { ...l, amount: nextAmount.toString(), orderCount: nextCount } : l));
  }

  nextLevels = [...nextLevels].sort((a, b) => {
    const pa = BigInt(a.price);
    const pb = BigInt(b.price);
    if (pa === pb) return 0;
    if (side === "BUY") return pa > pb ? -1 : 1;
    return pa < pb ? -1 : 1;
  });

  return { ...book, [key]: nextLevels };
}

/** Opportunistic local update so the last price/volume/high/low react immediately to a new trade, without waiting for the next periodic /stats refresh to correct the window-relative fields (openPrice, changePct) precisely. */
function applyTradeToStats(stats: MatcherStats, trade: MatcherTrade): MatcherStats {
  const price = BigInt(trade.price);
  const high = stats.high === null || price > BigInt(stats.high) ? price : BigInt(stats.high);
  const low = stats.low === null || price < BigInt(stats.low) ? price : BigInt(stats.low);
  const openPrice = stats.openPrice === null ? price : BigInt(stats.openPrice);
  const volumeBase = BigInt(stats.volumeBase) + BigInt(trade.amount);
  const changePct = openPrice > 0n ? (Number(price - openPrice) / Number(openPrice)) * 100 : null;

  return {
    ...stats,
    lastPrice: price.toString(),
    openPrice: openPrice.toString(),
    high: high.toString(),
    low: low.toString(),
    volumeBase: volumeBase.toString(),
    tradeCount: stats.tradeCount + 1,
    changePct,
  };
}

/**
 * Live market data (orderbook, trade tape, rolling stats) for one asset
 * pair — fetched once from the Matcher's REST snapshot endpoints, then kept
 * current from its existing WS lifecycle events (see matcher/API.md) rather
 * than repolling. `order.matched` can't be applied as a precise orderbook
 * delta (its payload only carries the resting/maker leg's price, not the
 * taker's own price — see services/OrderService.ts on the Matcher), so that
 * event triggers a snapshot refetch instead of a guess.
 */
export function useMarketData(pair: AssetPair): MarketDataState {
  const [state, setState] = useState<MarketDataState>({
    orderBook: null,
    trades: [],
    stats: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    const asset: MatcherEitherAsset = { isLeft: true, left: pair.baseAssetId, right: pair.quoteAssetId };
    let cancelled = false;

    setState({ orderBook: null, trades: [], stats: null, loading: true, error: null });

    async function loadSnapshot() {
      try {
        const [orderBook, tradesResponse, stats] = await Promise.all([
          getOrderBook(asset),
          getTrades(asset, MAX_TRADES),
          getStats(asset),
        ]);
        if (cancelled) return;
        setState({ orderBook, trades: tradesResponse.trades, stats, loading: false, error: null });
      } catch (err) {
        if (cancelled) return;
        setState((prev) => ({
          ...prev,
          loading: false,
          error: err instanceof Error ? err.message : "Failed to load market data",
        }));
      }
    }

    async function refreshOrderBook() {
      try {
        const orderBook = await getOrderBook(asset);
        if (!cancelled) setState((prev) => ({ ...prev, orderBook }));
      } catch {
        // Transient — the next scheduled refresh retries.
      }
    }

    async function refreshStats() {
      try {
        const stats = await getStats(asset);
        if (!cancelled) setState((prev) => ({ ...prev, stats }));
      } catch {
        // Transient — the next scheduled refresh retries.
      }
    }

    void loadSnapshot();

    const unsubscribe = matcher.subscribeMessages((message) => {
      switch (message.type) {
        case "order.created": {
          if (!sameAsset(message.payload.asset, asset)) return;
          const order = message.payload;
          setState((prev) =>
            prev.orderBook
              ? { ...prev, orderBook: applyLevelDelta(prev.orderBook, order.side, order.price, order.amount, 1) }
              : prev,
          );
          return;
        }
        case "order.cancelled":
        case "order.expired": {
          if (!sameAsset(message.payload.asset, asset)) return;
          const order = message.payload;
          setState((prev) =>
            prev.orderBook
              ? { ...prev, orderBook: applyLevelDelta(prev.orderBook, order.side, order.price, order.amount, -1) }
              : prev,
          );
          return;
        }
        case "order.matched": {
          if (!sameAsset(message.payload.asset, asset)) return;
          void refreshOrderBook();
          const match = message.payload;
          setState((prev) => {
            const trade: MatcherTrade = { id: match.id, asset: match.asset, price: match.price, amount: match.amount, matchedAt: match.matchedAt };
            const trades = [trade, ...prev.trades.filter((t) => t.id !== trade.id)].slice(0, MAX_TRADES);
            const stats = prev.stats ? applyTradeToStats(prev.stats, trade) : prev.stats;
            return { ...prev, trades, stats };
          });
          return;
        }
        default:
          return;
      }
    });

    const statsInterval = window.setInterval(() => void refreshStats(), STATS_REFRESH_MS);
    const orderBookInterval = window.setInterval(() => void refreshOrderBook(), ORDERBOOK_REFRESH_MS);

    return () => {
      cancelled = true;
      unsubscribe();
      window.clearInterval(statsInterval);
      window.clearInterval(orderBookInterval);
    };
  }, [pair.baseAssetId, pair.quoteAssetId]);

  return state;
}
