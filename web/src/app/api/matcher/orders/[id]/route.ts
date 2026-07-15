import { NextResponse } from "next/server";

/**
 * Same-origin proxy for `GET /orders/:id` and `DELETE /orders/:id` on the
 * Matcher REST API (matcher/API.md). `DELETE` here is Matcher-book-only —
 * it does not submit an on-chain `cancelOrder()` (see matcher/API.md).
 */
const MATCHER_API_URL = process.env.MATCHER_API_URL?.trim() || "http://localhost:4000";

export async function GET(_request: Request, ctx: RouteContext<"/api/matcher/orders/[id]">) {
  const { id } = await ctx.params;
  const response = await fetch(`${MATCHER_API_URL}/orders/${id}`);
  const data = await response.text();
  return new NextResponse(data, {
    status: response.status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function DELETE(_request: Request, ctx: RouteContext<"/api/matcher/orders/[id]">) {
  const { id } = await ctx.params;
  const response = await fetch(`${MATCHER_API_URL}/orders/${id}`, { method: "DELETE" });
  const data = await response.text();
  return new NextResponse(data, {
    status: response.status,
    headers: { "Content-Type": "application/json" },
  });
}
