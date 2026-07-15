/**
 * Typed client for the Matcher REST API (matcher/API.md), called through
 * this app's own same-origin proxy routes (app/api/matcher/**) rather than
 * the Matcher directly — the Matcher has no CORS headers and must not be
 * modified, so a same-origin server-side proxy is the only way a browser
 * can call it.
 */
import type {
  CreateOrderRequest,
  CreateOrderResponse,
  MatcherEitherAsset,
  MatcherErrorBody,
  MatcherOrder,
  MatcherOrderBookSnapshot,
  MatcherStats,
  MatcherTrade,
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

function assetParams(asset: MatcherEitherAsset): URLSearchParams {
  return new URLSearchParams({ isLeft: String(asset.isLeft), left: asset.left, right: asset.right });
}

export async function getOrderBook(asset: MatcherEitherAsset): Promise<MatcherOrderBookSnapshot> {
  const response = await fetch(`/api/matcher/orderbook?${assetParams(asset)}`);
  return parseJsonOrThrow<MatcherOrderBookSnapshot>(response);
}

export async function getTrades(asset: MatcherEitherAsset, limit = 50): Promise<{ trades: MatcherTrade[] }> {
  const params = assetParams(asset);
  params.set("limit", String(limit));
  const response = await fetch(`/api/matcher/trades?${params}`);
  return parseJsonOrThrow<{ trades: MatcherTrade[] }>(response);
}

export async function getStats(asset: MatcherEitherAsset, windowMs?: number): Promise<MatcherStats> {
  const params = assetParams(asset);
  if (windowMs !== undefined) params.set("windowMs", String(windowMs));
  const response = await fetch(`/api/matcher/stats?${params}`);
  return parseJsonOrThrow<MatcherStats>(response);
}
