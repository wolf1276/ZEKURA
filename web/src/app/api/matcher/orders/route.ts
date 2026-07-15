import { NextResponse } from "next/server";

/**
 * Same-origin proxy for `POST /orders` on the Matcher REST API
 * (matcher/API.md). The Matcher has no CORS headers and must not be
 * modified, so the browser can't call it directly — this route runs
 * server-side (no CORS involved) and simply forwards the request/response
 * verbatim.
 */
const MATCHER_API_URL = process.env.MATCHER_API_URL?.trim() || "http://localhost:4000";

export async function POST(request: Request) {
  const body = await request.text();
  const response = await fetch(`${MATCHER_API_URL}/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const data = await response.text();
  return new NextResponse(data, {
    status: response.status,
    headers: { "Content-Type": "application/json" },
  });
}
