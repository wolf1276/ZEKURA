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

/**
 * The traded (non-NIGHT) asset's real, chain-wide unshielded token color —
 * a plain Bytes<32> hex string, identical to the on-chain OrderDetails.asset
 * field and the Treasury's assetKey (see contracts/exchange.compact and
 * docs/ARCHITECTURE_TZKR_UNSHIELDED_MIGRATION.md). Previously an
 * {isLeft,left,right} tuple hashed server-side via deriveAssetKey into an
 * arbitrary key with no chain meaning.
 */
export type MatcherAsset = string;

export interface MatcherOrder {
  id: string;
  asset: MatcherAsset;
  side: MatcherOrderSide;
  price: string;
  amount: string;
  commitment: string;
  ownerId: string;
  status: MatcherOrderStatus;
  createdAt: number;
  expiresAt: string;
  /** Real unshielded UserAddress (hex), opt-in — required only for this order to be eligible for a protocol-liquidity fill. null means user-vs-user matching only. */
  payoutAddress: string | null;
}

export interface MatcherMatch {
  id: string;
  buyOrderId: string;
  sellOrderId: string;
  asset: MatcherAsset;
  price: string;
  amount: string;
  matchedAt: number;
}

export interface CreateOrderRequest {
  id: string;
  asset: MatcherAsset;
  side: MatcherOrderSide;
  price: string;
  amount: string;
  commitment: string;
  ownerId: string;
  /** The order's blinding factor — see matcher/API.md and ARCHITECTURE.md's security model. */
  signature: string;
  expiresAt: string;
  /** See MatcherOrder.payoutAddress. */
  payoutAddress?: string | null;
}

/** A fill against protocol liquidity instead of a second user order. */
export interface MatcherProtocolFill {
  quoteId: string;
  price: string;
  amount: string;
  txId: string;
}

/** PPM reserved liquidity but did not settle — the order stays OPEN until this order's own owner submits settleWithProtocol (see hooks/use-order-actions.ts). */
export interface MatcherPendingQuote {
  quoteId: string;
  price: string;
  amount: string;
  expiresAt: string;
}

export interface CreateOrderResponse {
  order: MatcherOrder;
  match: MatcherMatch | null;
  protocolFill: MatcherProtocolFill | null;
  pendingProtocolQuote: MatcherPendingQuote | null;
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
  asset: MatcherAsset;
  /** Highest price first. */
  bids: MatcherOrderBookLevel[];
  /** Lowest price first. */
  asks: MatcherOrderBookLevel[];
}

export interface MatcherTrade {
  id: string;
  asset: MatcherAsset;
  price: string;
  amount: string;
  matchedAt: number;
}

export interface MatcherStats {
  asset: MatcherAsset;
  lastPrice: string | null;
  openPrice: string | null;
  high: string | null;
  low: string | null;
  volumeBase: string;
  tradeCount: number;
  changePct: number | null;
}

/**
 * order.filled carries one of two shapes depending on who supplied the
 * counterparty liquidity — a second user order (settled asynchronously by
 * SettlementService) or the Treasury/PPM (settled synchronously within the
 * same request that submitted the order). Distinguish by the presence of
 * `matchedWith` — see components/trade's "Matched With" badge.
 */
export type MatcherOrderFilledPayload =
  | { match: MatcherMatch; txId: string | null; matchedWith?: undefined }
  | {
      order: MatcherOrder;
      matchedWith: "protocol";
      quoteId: string;
      price: string;
      amount: string;
      txId: string;
    };

/**
 * The PPM reserved liquidity against a resting order but did NOT settle —
 * the order stays OPEN until its own owner's wallet submits
 * settleWithProtocol (the "Approve Settlement" step; see
 * hooks/use-order-actions.ts). Broadcast so any session that owns the order
 * (a second tab, or this same session if the order rested before getting
 * PPM-filled) can surface the approval prompt — the submitting session also
 * gets this synchronously via CreateOrderResponse.pendingProtocolQuote.
 */
export interface MatcherPpmQuoteReadyPayload {
  orderId: string;
  quoteId: string;
  assetKey: string;
  side: MatcherOrderSide;
  amount: string;
  price: string;
  expiresAt: string;
}

export type MatcherWsMessage =
  | { type: "order.created"; payload: MatcherOrder; timestamp: number }
  | { type: "order.matched"; payload: MatcherMatch; timestamp: number }
  | { type: "order.settling"; payload: { match: MatcherMatch }; timestamp: number }
  | { type: "order.filled"; payload: MatcherOrderFilledPayload; timestamp: number }
  | {
      type: "order.failed";
      payload: { match: MatcherMatch; reason: string };
      timestamp: number;
    }
  | { type: "order.cancelled"; payload: MatcherOrder; timestamp: number }
  | { type: "order.expired"; payload: MatcherOrder; timestamp: number }
  | { type: "order.ppm_quote_ready"; payload: MatcherPpmQuoteReadyPayload; timestamp: number }
  | { type: "treasury.deposited"; payload: { assetKey: string; amount: string; txId: string }; timestamp: number }
  | { type: "treasury.withdrawn"; payload: { assetKey: string; amount: string; txId: string }; timestamp: number }
  | {
      type: "treasury.reserved";
      payload: { quoteId: string; assetKey: string; amount: string; price: string; expiresAt: string };
      timestamp: number;
    }
  | { type: "treasury.released"; payload: { quoteId: string; assetKey: string; amount: string }; timestamp: number };

// ─── Treasury / PPM / Admin ─────────────────────────────────────────────

export interface MatcherTreasuryBalance {
  assetKey: string;
  balance: string;
  reserved: string;
  available: string;
}

export type MatcherTreasuryEventKind = "DEPOSIT" | "WITHDRAW" | "RESERVE" | "RELEASE" | "EXECUTE";

export interface MatcherTreasuryEvent {
  id: string;
  kind: MatcherTreasuryEventKind;
  assetKey: string;
  amount: string;
  /** deriveAdminId(...) for DEPOSIT/WITHDRAW, quoteId for RESERVE/RELEASE/EXECUTE. */
  actor: string;
  txId: string | null;
  createdAt: number;
}

export interface MatcherTreasuryHistoryResponse {
  events: MatcherTreasuryEvent[];
}

export type MatcherPpmRiskStatus = "empty" | "healthy" | "elevated" | "critical";

export interface MatcherPpmStatus extends MatcherTreasuryBalance {
  riskStatus: MatcherPpmRiskStatus;
  config: {
    baseSpreadBps: number;
    maxExposureFraction: number;
    inventorySkewBps: number;
    quoteTtlSeconds: string;
  };
}

export interface AdminChallengeRequest {
  address: string;
}

export interface AdminChallengeResponse {
  nonce: string;
  expiresAt: number;
}

export interface AdminAuthPayload {
  address: string;
  publicKey: string;
  signature: string;
}

export interface AdminDepositRequest {
  auth: AdminAuthPayload;
  assetKey: string;
  amount: string;
}

export interface AdminWithdrawRequest {
  auth: AdminAuthPayload;
  assetKey: string;
  amount: string;
  recipientUserAddress: string;
}

export interface AdminTxResponse {
  txId: string;
}
