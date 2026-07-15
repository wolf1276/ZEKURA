import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { NextResponse } from "next/server";

/**
 * Streams the already-compiled ZK artifacts for the exchange contract
 * (contracts/managed/exchange/{keys,zkir}/*) to the browser's
 * FetchZkConfigProvider, which expects exactly this layout:
 * `{baseURL}/keys/{circuit}.{prover,verifier}` and `{baseURL}/zkir/{circuit}.bzkir`
 * (see @midnight-ntwrk/midnight-js-fetch-zk-config-provider's README) — the
 * compiled output already matches that layout 1:1, so this route is a
 * direct, read-only passthrough. It never touches the contract source.
 */
const EXCHANGE_ZK_DIR = path.join(process.cwd(), "..", "contracts", "managed", "exchange");

const SAFE_SEGMENT = /^[A-Za-z0-9_.-]+$/;

export async function GET(
  _request: Request,
  ctx: RouteContext<"/zk/exchange/[...path]">,
) {
  const { path: segments } = await ctx.params;

  if (segments.length === 0 || !segments.every((segment) => SAFE_SEGMENT.test(segment))) {
    return NextResponse.json({ error: "invalid_path" }, { status: 400 });
  }

  const filePath = path.join(EXCHANGE_ZK_DIR, ...segments);
  if (!filePath.startsWith(EXCHANGE_ZK_DIR + path.sep)) {
    return NextResponse.json({ error: "invalid_path" }, { status: 400 });
  }

  try {
    const data = await readFile(filePath);
    return new NextResponse(new Uint8Array(data), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
}
