import type { MatcherOrderBookSnapshot, MatcherStats } from "@/types/matcher";
import type { MarketInsights } from "./types";

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function toNumber(value: string | null): number | null {
  return value === null ? null : Number(value);
}

function volatilityFrom(stats: MatcherStats, mid: number): "Low" | "Medium" | "High" {
  const high = toNumber(stats.high);
  const low = toNumber(stats.low);
  if (high === null || low === null || mid <= 0) return "Low";
  const rangePct = ((high - low) / mid) * 100;
  if (rangePct >= 5) return "High";
  if (rangePct >= 1) return "Medium";
  return "Low";
}

/**
 * Derives the same MarketInsights shape the UI already renders as confidence
 * bands / liquidity zones — but from the Matcher's real orderbook + stats
 * snapshots instead of a fixed percentage of a hardcoded mid price.
 * Deliberately never surfaces an exact price level, size, or order count
 * (see components/trade/market-insights.tsx's "no public order book"
 * framing) — only ranges derived from where the real inside market
 * currently sits.
 */
export function deriveMarketInsights(orderBook: MatcherOrderBookSnapshot, stats: MatcherStats): MarketInsights {
  const bestBid = orderBook.bids[0] ? Number(orderBook.bids[0].price) : null;
  const bestAsk = orderBook.asks[0] ? Number(orderBook.asks[0].price) : null;
  const lastPrice = toNumber(stats.lastPrice);
  const mid = lastPrice ?? (bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : (bestBid ?? bestAsk ?? 1));

  // A real spread when both sides of the book are present; otherwise a
  // placeholder width (2% of mid) so the bands stay a sensible size around a
  // thin or empty book instead of collapsing to zero.
  const spread = bestBid !== null && bestAsk !== null && bestAsk > bestBid ? bestAsk - bestBid : mid * 0.02;

  return {
    suggestedBuy: { low: round(mid - spread * 1.2), high: round(bestAsk ?? mid + spread * 0.5) },
    suggestedSell: { low: round(bestBid ?? mid - spread * 0.5), high: round(mid + spread * 1.2) },
    liquidityZones: {
      strong: { low: round(bestBid ?? mid - spread * 0.5), high: round(bestAsk ?? mid + spread * 0.5) },
      moderate: { low: round(mid - spread * 1.8), high: round(mid + spread * 1.8) },
      emerging: { low: round(mid - spread * 3), high: round(mid + spread * 3) },
    },
    activityLevel: stats.tradeCount >= 20 ? "High" : stats.tradeCount >= 5 ? "Medium" : "Low",
    volatility: volatilityFrom(stats, mid),
    // No settlement-latency telemetry is exposed by the Matcher yet (it
    // tracks settlement attempts internally — see matcher/src/services/
    // SettlementService.ts — but doesn't aggregate timing stats over an API)
    // — kept as the same illustrative range the mock previously used rather
    // than fabricating precision the Matcher can't back up.
    estimatedSettlementSeconds: { low: 30, high: 90 },
  };
}
