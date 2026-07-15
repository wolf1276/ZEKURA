import { NextResponse } from "next/server";

/** Same-origin proxy for `GET /orders/open` on the Matcher REST API (matcher/API.md). */
const MATCHER_API_URL = process.env.MATCHER_API_URL?.trim() || "http://localhost:4000";

export async function GET() {
  const response = await fetch(`${MATCHER_API_URL}/orders/open`);
  const data = await response.text();
  return new NextResponse(data, {
    status: response.status,
    headers: { "Content-Type": "application/json" },
  });
}
