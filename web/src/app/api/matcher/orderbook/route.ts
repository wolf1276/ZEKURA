import { NextResponse } from "next/server";

/** Same-origin proxy for `GET /orderbook` on the Matcher REST API (matcher/API.md). */
const MATCHER_API_URL = process.env.MATCHER_API_URL?.trim() || "http://localhost:4000";

export async function GET(request: Request) {
  const { search } = new URL(request.url);
  const response = await fetch(`${MATCHER_API_URL}/orderbook${search}`);
  const data = await response.text();
  return new NextResponse(data, {
    status: response.status,
    headers: { "Content-Type": "application/json" },
  });
}
