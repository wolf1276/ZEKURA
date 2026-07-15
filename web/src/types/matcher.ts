/**
 * Wire types for the Matcher REST/WS API, mirroring matcher/API.md exactly
 * (field names, casing, and the decimal-string convention for
 * price/amount/expiresAt — Uint<128>/Uint<64> on-chain, which can exceed
 * Number.MAX_SAFE_INTEGER).
 */

export type MatcherOrderSide = "BUY" | "SELL";

export type MatcherOrderStatus =
  | "OPEN"
  | "MATCHED"
  | "SETTLING"
  | "FILLED"
  | "CANCELLED"
  | "EXPIRED"
  | "FAILED";

export interface MatcherEitherAsset {
  isLeft: boolean;
  left: string;
  right: string;
}

export interface MatcherOrder {
  id: string;
  asset: MatcherEitherAsset;
  side: MatcherOrderSide;
  price: string;
  amount: string;
  commitment: string;
  ownerId: string;
  status: MatcherOrderStatus;
  createdAt: number;
  expiresAt: string;
}

export interface MatcherMatch {
  id: string;
  buyOrderId: string;
  sellOrderId: string;
  asset: MatcherEitherAsset;
  price: string;
  amount: string;
  matchedAt: number;
}

export interface CreateOrderRequest {
  id: string;
  asset: MatcherEitherAsset;
  side: MatcherOrderSide;
  price: string;
  amount: string;
  commitment: string;
  ownerId: string;
  /** The order's blinding factor — see matcher/API.md and ARCHITECTURE.md's security model. */
  signature: string;
  expiresAt: string;
}

export interface CreateOrderResponse {
  order: MatcherOrder;
  match: MatcherMatch | null;
}

export type MatcherErrorCode =
  | "validation_failed"
  | "DUPLICATE"
  | "SIGNATURE_INVALID"
  | "NOT_ON_CHAIN"
  | "COMMITMENT_MISMATCH"
  | "NOT_OPEN_ON_CHAIN"
  | "EXPIRED"
  | "NOT_FOUND"
  | "NOT_CANCELLABLE"
  | "NOT_FOUND_ROUTE"
  | "INTERNAL_ERROR";

export interface MatcherErrorBody {
  error: string;
  message: string;
  issues?: unknown;
}

export interface MatcherOrderBookLevel {
  price: string;
  amount: string;
  orderCount: number;
}

export interface MatcherOrderBookSnapshot {
  asset: MatcherEitherAsset;
  /** Highest price first. */
  bids: MatcherOrderBookLevel[];
  /** Lowest price first. */
  asks: MatcherOrderBookLevel[];
}

export interface MatcherTrade {
  id: string;
  asset: MatcherEitherAsset;
  price: string;
  amount: string;
  matchedAt: number;
}

export interface MatcherStats {
  asset: MatcherEitherAsset;
  lastPrice: string | null;
  openPrice: string | null;
  high: string | null;
  low: string | null;
  volumeBase: string;
  tradeCount: number;
  changePct: number | null;
}

export type MatcherWsMessage =
  | { type: "order.created"; payload: MatcherOrder; timestamp: number }
  | { type: "order.matched"; payload: MatcherMatch; timestamp: number }
  | { type: "order.settling"; payload: { match: MatcherMatch }; timestamp: number }
  | {
      type: "order.filled";
      payload: { match: MatcherMatch; txId: string | null };
      timestamp: number;
    }
  | {
      type: "order.failed";
      payload: { match: MatcherMatch; reason: string };
      timestamp: number;
    }
  | { type: "order.cancelled"; payload: MatcherOrder; timestamp: number }
  | { type: "order.expired"; payload: MatcherOrder; timestamp: number };
