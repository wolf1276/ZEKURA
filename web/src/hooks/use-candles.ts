"use client";

import { useEffect, useState } from "react";
import { getTrades } from "@/services/matcher/api";
import { matcher } from "@/services/matcher/matcherClient";
import { buildCandlesFromTrades } from "@/lib/candles";
import type { AssetPair, Candle, Timeframe } from "@/lib/types";
import type { MatcherTrade } from "@/types/matcher";

// Real chart history needs more depth than the 50-trade cap useMarketData's
// shared trade tape keeps for the Activity/Recent-Trades panels — this hook
// fetches its own copy at a higher limit rather than raising that shared
// cap for every other consumer.
const CHART_TRADE_HISTORY_LIMIT = 1000;

interface CandleState {
  trades: MatcherTrade[];
  loading: boolean;
}

/**
 * Real OHLCV candles for one asset pair + timeframe, built from the
 * Matcher's actual trade tape (see lib/candles.ts) and kept live from the
 * same order.matched/order.filled WS events useMarketData reacts to. Empty
 * until the pair has real trade history — never seeded with synthetic data.
 */
export function useCandles(pair: AssetPair, timeframe: Timeframe): { candles: Candle[]; loading: boolean } {
  const [state, setState] = useState<CandleState>({ trades: [], loading: true });

  useEffect(() => {
    // The contract's asset field only ever names the traded (non-NIGHT)
    // asset — for this app's tNIGHT/tZKR pair that's always the quote asset
    // (see hooks/use-submit-order.ts's OrderDetails.asset doc comment).
    const asset = pair.quoteAssetId;
    let cancelled = false;

    // Deliberately does not reset to {trades: [], loading: true} first — the
    // previous pair's candles stay on screen (a real, if momentarily stale,
    // chart) until this pair's real data arrives, rather than flashing to a
    // synthetic empty/loading state on every pair switch.
    async function loadTrades() {
      try {
        const response = await getTrades(asset, CHART_TRADE_HISTORY_LIMIT);
        if (!cancelled) setState({ trades: response.trades, loading: false });
      } catch {
        // Transient — the WS stream below still keeps new trades flowing in.
        if (!cancelled) setState((prev) => ({ ...prev, loading: false }));
      }
    }
    void loadTrades();

    const unsubscribe = matcher.subscribeMessages((message) => {
      if (message.type === "order.matched") {
        if (message.payload.asset !== asset) return;
        const match = message.payload;
        const trade: MatcherTrade = { id: match.id, asset: match.asset, price: match.price, amount: match.amount, matchedAt: match.matchedAt };
        setState((prev) => ({ ...prev, trades: [trade, ...prev.trades.filter((t) => t.id !== trade.id)].slice(0, CHART_TRADE_HISTORY_LIMIT) }));
        return;
      }
      if (message.type === "order.filled" && "order" in message.payload) {
        if (message.payload.order.asset !== asset) return;
        const { order, price, amount, txId } = message.payload;
        const trade: MatcherTrade = { id: txId, asset: order.asset, price, amount, matchedAt: Date.now() };
        setState((prev) => ({ ...prev, trades: [trade, ...prev.trades.filter((t) => t.id !== trade.id)].slice(0, CHART_TRADE_HISTORY_LIMIT) }));
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [pair.quoteAssetId]);

  return { candles: buildCandlesFromTrades(state.trades, timeframe), loading: state.loading };
}
