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

/**
 * A pair's on-chain `asset` field is an `Either<Bytes<32>, Bytes<32>>` whose
 * meaning depends on `is_left` (contracts/exchange.compact's deriveAssetKey):
 *   - `is_left: true`  — a shielded/opaque pair id. deriveAssetKey hashes it,
 *     so the Treasury can never hold real backing for it (no token can equal
 *     a hash of itself) — fine for display-only or off-chain-settled pairs,
 *     but PPM/Treasury deposits are impossible.
 *   - `is_left: false` — a real unshielded asset. deriveAssetKey returns
 *     `quoteAssetId`/`right` UNCHANGED, so it must be a genuine on-chain
 *     token type (receiveUnshielded/sendUnshielded move exactly that type).
 *     This is the only shape PPM/Treasury funding can work against.
 *
 * See lib/mock/market.ts's `ASSET_PAIRS` for which pair currently uses which
 * shape, and its doc comment for the tZKR migration path.
 */
export interface AssetPair {
  id: string;
  base: string;
  quote: string;
  baseAssetId: string;
  quoteAssetId: string;
  /** Either.is_left for this pair's on-chain `asset` field — see doc comment above. */
  assetIsLeft: boolean;
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
  /** Hex-encoded deriveOwnerId(...) output — lets the UI recognize which open orders are this browser's own (see services/midnight/ownerSecret.ts), e.g. to compute reserved/locked balance. */
  ownerId: string;
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
  | "ORDER_FAILED"
  | "TREASURY_DEPOSITED"
  | "TREASURY_WITHDRAWN"
  | "TREASURY_RESERVED"
  | "TREASURY_RELEASED"
  | "TREASURY_EXECUTED";

/** Order-lifecycle fields are only present for ORDER_* kinds; Treasury/PPM fields only for TREASURY_* kinds. */
export interface ActivityEvent {
  id: string;
  kind: ActivityKind;
  timestamp: number;
  amount: string;
  orderId?: string;
  pair?: string;
  side?: OrderSide;
  price?: string;
  txId?: string | null;
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
