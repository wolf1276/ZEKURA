/**
 * Domain types mirror the Matcher REST/WS API (matcher/API.md) and the
 * on-chain enums in contracts/exchange.compact 1:1, so this layer can be
 * pointed at the real Matcher later without changing component code.
 */

export type OrderSide = "BUY" | "SELL";

/** Matcher order lifecycle — superset of the on-chain OrderState enum. */
export type OrderStatus =
  | "OPEN"
  | "MATCHED"
  | "SETTLING"
  | "FILLED"
  | "CANCELLED"
  | "EXPIRED"
  | "FAILED";

export type ExpiryOption = "10m" | "30m" | "1h" | "GTC";

export interface AssetPair {
  id: string;
  base: string;
  quote: string;
  baseAssetId: string;
  quoteAssetId: string;
}

/** price/amount/expiresAt are decimal strings on the wire (Uint<128>/Uint<64> can exceed Number.MAX_SAFE_INTEGER). */
export interface Order {
  id: string;
  pair: string;
  side: OrderSide;
  price: string;
  amount: string;
  status: OrderStatus;
  createdAt: number;
  expiresAt: string;
  expiryLabel: ExpiryOption;
}

export interface Match {
  id: string;
  buyOrderId: string;
  sellOrderId: string;
  pair: string;
  price: string;
  amount: string;
  matchedAt: number;
}

export type ActivityKind =
  | "ORDER_CREATED"
  | "ORDER_MATCHED"
  | "SETTLEMENT_STARTED"
  | "ORDER_FILLED"
  | "ORDER_CANCELLED"
  | "ORDER_EXPIRED"
  | "ORDER_FAILED";

export interface ActivityEvent {
  id: string;
  kind: ActivityKind;
  orderId: string;
  pair: string;
  side: OrderSide;
  amount: string;
  price: string;
  timestamp: number;
}

export type Timeframe = "1m" | "5m" | "15m" | "1H" | "4H" | "1D";

export interface Candle {
  time: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type OrderTimelineStage =
  | "CREATED"
  | "SEARCHING"
  | "MATCHED"
  | "SETTLED"
  | "COMPLETED";

/** Who actually supplied the counterparty side of a fill. */
export type MatchedWith = "user" | "protocol";

export interface TreasuryLiquidity {
  assetKey: string;
  balance: string;
  reserved: string;
  available: string;
}

export type TreasuryEventKind = "DEPOSIT" | "WITHDRAW" | "RESERVE" | "RELEASE" | "EXECUTE";

export interface TreasuryEvent {
  id: string;
  kind: TreasuryEventKind;
  assetKey: string;
  amount: string;
  actor: string;
  txId: string | null;
  createdAt: number;
}

export type PpmRiskStatus = "empty" | "healthy" | "elevated" | "critical";

export interface PpmStatus extends TreasuryLiquidity {
  riskStatus: PpmRiskStatus;
  config: {
    baseSpreadBps: number;
    maxExposureFraction: number;
    inventorySkewBps: number;
    quoteTtlSeconds: string;
  };
}

export interface MarketInsights {
  suggestedBuy: { low: number; high: number };
  suggestedSell: { low: number; high: number };
  liquidityZones: {
    strong: { low: number; high: number };
    moderate: { low: number; high: number };
    emerging: { low: number; high: number };
  };
  activityLevel: "Low" | "Medium" | "High";
  volatility: "Low" | "Medium" | "High";
  estimatedSettlementSeconds: { low: number; high: number };
}
