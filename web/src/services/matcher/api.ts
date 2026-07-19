/**
 * Typed client for the Matcher REST API (matcher/API.md), called through
 * this app's own same-origin proxy routes (app/api/matcher/**) rather than
 * the Matcher directly — the Matcher has no CORS headers and must not be
 * modified, so a same-origin server-side proxy is the only way a browser
 * can call it.
 */
import type {
  AdminChallengeRequest,
  AdminChallengeResponse,
  AdminDepositRequest,
  AdminTxResponse,
  AdminWithdrawRequest,
  CreateOrderRequest,
  CreateOrderResponse,
  MatcherAsset,
  MatcherErrorBody,
  MatcherOrder,
  MatcherOrderBookSnapshot,
  MatcherPpmStatus,
  MatcherStats,
  MatcherTrade,
  MatcherTreasuryBalance,
  MatcherTreasuryEventKind,
  MatcherTreasuryHistoryResponse,
} from "@/types/matcher";

export class MatcherApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, body: MatcherErrorBody) {
    super(body.message || body.error);
    this.name = "MatcherApiError";
    this.status = status;
    this.code = body.error;
  }
}

async function parseJsonOrThrow<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new MatcherApiError(
      response.status,
      (body as MatcherErrorBody | null) ?? { error: "unknown", message: response.statusText },
    );
  }
  return body as T;
}

export async function submitOrder(request: CreateOrderRequest): Promise<CreateOrderResponse> {
  const response = await fetch("/api/matcher/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  return parseJsonOrThrow<CreateOrderResponse>(response);
}

export async function cancelOrder(id: string): Promise<{ order: MatcherOrder }> {
  const response = await fetch(`/api/matcher/orders/${id}`, { method: "DELETE" });
  return parseJsonOrThrow<{ order: MatcherOrder }>(response);
}

export async function getOrder(id: string): Promise<{ order: MatcherOrder }> {
  const response = await fetch(`/api/matcher/orders/${id}`);
  return parseJsonOrThrow<{ order: MatcherOrder }>(response);
}

export async function listOpenOrders(): Promise<{ orders: MatcherOrder[] }> {
  const response = await fetch("/api/matcher/orders/open");
  return parseJsonOrThrow<{ orders: MatcherOrder[] }>(response);
}

export async function getOrderBook(asset: MatcherAsset): Promise<MatcherOrderBookSnapshot> {
  const response = await fetch(`/api/matcher/orderbook?${new URLSearchParams({ asset })}`);
  return parseJsonOrThrow<MatcherOrderBookSnapshot>(response);
}

export async function getTrades(asset: MatcherAsset, limit = 50): Promise<{ trades: MatcherTrade[] }> {
  const params = new URLSearchParams({ asset, limit: String(limit) });
  const response = await fetch(`/api/matcher/trades?${params}`);
  return parseJsonOrThrow<{ trades: MatcherTrade[] }>(response);
}

export async function getStats(asset: MatcherAsset, windowMs?: number): Promise<MatcherStats> {
  const params = new URLSearchParams({ asset });
  if (windowMs !== undefined) params.set("windowMs", String(windowMs));
  const response = await fetch(`/api/matcher/stats?${params}`);
  return parseJsonOrThrow<MatcherStats>(response);
}

// ─── Treasury / PPM / Admin ─────────────────────────────────────────────
//
// Treasury/PPM balance routes are keyed by the raw on-chain assetKey — the
// same value as a trading pair's own asset (e.g. the real native tNIGHT
// token type (lib/nativeAsset.ts), or tZKR's minted color). Previously these
// were two distinct keys (a raw token type vs. an order-shaped tuple hashed
// server-side via deriveAssetKey); now one function covers both callers.

export async function getTreasuryBalance(assetKey: MatcherAsset): Promise<MatcherTreasuryBalance> {
  const response = await fetch(`/api/matcher/treasury/balance?${new URLSearchParams({ assetKey })}`);
  return parseJsonOrThrow<MatcherTreasuryBalance>(response);
}

export async function getTreasuryHistory(limit = 50, kind?: MatcherTreasuryEventKind): Promise<MatcherTreasuryHistoryResponse> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (kind) params.set("kind", kind);
  const response = await fetch(`/api/matcher/treasury/history?${params}`);
  return parseJsonOrThrow<MatcherTreasuryHistoryResponse>(response);
}

export async function getPpmStatus(assetKey: MatcherAsset): Promise<MatcherPpmStatus> {
  const response = await fetch(`/api/matcher/ppm/status?${new URLSearchParams({ assetKey })}`);
  return parseJsonOrThrow<MatcherPpmStatus>(response);
}

export async function requestAdminChallenge(request: AdminChallengeRequest): Promise<AdminChallengeResponse> {
  const response = await fetch("/api/matcher/admin/challenge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  return parseJsonOrThrow<AdminChallengeResponse>(response);
}

export async function depositTreasury(request: AdminDepositRequest): Promise<AdminTxResponse> {
  const response = await fetch("/api/matcher/admin/treasury/deposit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  return parseJsonOrThrow<AdminTxResponse>(response);
}

export async function withdrawTreasury(request: AdminWithdrawRequest): Promise<AdminTxResponse> {
  const response = await fetch("/api/matcher/admin/treasury/withdraw", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  return parseJsonOrThrow<AdminTxResponse>(response);
}
