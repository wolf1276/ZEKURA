import type { Candle, Timeframe } from "@/lib/types";
import type { MatcherTrade } from "@/types/matcher";

const TIMEFRAME_SECONDS: Record<Timeframe, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1H": 3600,
  "4H": 14400,
  "1D": 86400,
};

/**
 * Real OHLCV candles, bucketed from the Matcher's actual settled-trade tape
 * (`GET /trades`, kept live via the `order.matched`/`order.filled` WS
 * events — see hooks/use-candles.ts). No synthetic price walk: a bucket
 * with no trades in it is simply absent from the result, so a thin trade
 * history produces a sparse chart rather than a fabricated one. `trades`
 * may be in any order; this function sorts by `matchedAt` itself.
 */
export function buildCandlesFromTrades(trades: readonly MatcherTrade[], timeframe: Timeframe): Candle[] {
  if (trades.length === 0) return [];

  const stepSeconds = TIMEFRAME_SECONDS[timeframe];
  const sorted = [...trades].sort((a, b) => a.matchedAt - b.matchedAt);

  const buckets = new Map<number, Candle>();
  for (const trade of sorted) {
    const price = Number(trade.price);
    const amount = Number(trade.amount);
    const bucketTime = Math.floor(trade.matchedAt / 1000 / stepSeconds) * stepSeconds;

    const existing = buckets.get(bucketTime);
    if (!existing) {
      buckets.set(bucketTime, { time: bucketTime, open: price, high: price, low: price, close: price, volume: amount });
    } else {
      existing.high = Math.max(existing.high, price);
      existing.low = Math.min(existing.low, price);
      existing.close = price;
      existing.volume += amount;
    }
  }

  return Array.from(buckets.values()).sort((a, b) => a.time - b.time);
}

/** Latest real reference price from the trade tape, or null if there's no trade history yet — never a fabricated seed value. */
export function latestPrice(trades: readonly MatcherTrade[]): number | null {
  if (trades.length === 0) return null;
  const latest = trades.reduce((a, b) => (a.matchedAt > b.matchedAt ? a : b));
  return Number(latest.price);
}
