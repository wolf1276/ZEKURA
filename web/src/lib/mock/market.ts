import type { AssetPair, MarketInsights } from "@/lib/types";

export const ASSET_PAIRS: AssetPair[] = [
  {
    id: "tDUST-tUSD",
    base: "tDUST",
    quote: "tUSD",
    baseAssetId: "a1".padEnd(64, "0"),
    quoteAssetId: "b2".padEnd(64, "0"),
  },
  {
    id: "tNIGHT-tUSD",
    base: "tNIGHT",
    quote: "tUSD",
    baseAssetId: "c3".padEnd(64, "0"),
    quoteAssetId: "b2".padEnd(64, "0"),
  },
];

export const DEFAULT_PAIR = ASSET_PAIRS[0];

export function getMarketInsights(midPrice: number): MarketInsights {
  return {
    suggestedBuy: { low: round(midPrice * 0.976), high: round(midPrice * 1.005) },
    suggestedSell: { low: round(midPrice * 0.995), high: round(midPrice * 1.025) },
    liquidityZones: {
      strong: { low: round(midPrice * 0.976), high: round(midPrice * 1.005) },
      moderate: { low: round(midPrice * 1.0), high: round(midPrice * 1.036) },
      emerging: { low: round(midPrice * 1.036), high: round(midPrice * 1.06) },
    },
    activityLevel: "Medium",
    volatility: "Medium",
    estimatedSettlementSeconds: { low: 30, high: 90 },
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
