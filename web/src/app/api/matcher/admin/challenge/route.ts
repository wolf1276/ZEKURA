import { NextResponse } from "next/server";

/** Same-origin proxy for `POST /admin/challenge` on the Matcher REST API. */
const MATCHER_API_URL = process.env.MATCHER_API_URL?.trim() || "http://localhost:4000";

export async function POST(request: Request) {
  const body = await request.text();
  const response = await fetch(`${MATCHER_API_URL}/admin/challenge`, {
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
