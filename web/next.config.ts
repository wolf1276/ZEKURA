import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The compiled exchange contract lives one level up (see turbopack.root
  // below); the production file tracer otherwise stops at this directory
  // and won't bundle it into the deployed serverless function.
  outputFileTracingRoot: path.join(__dirname, ".."),
  outputFileTracingIncludes: {
    // The /zk/exchange/[...path] route reads keys/zkir/contract files from
    // contracts/managed/exchange at request time via fs.readFile, which the
    // tracer can't discover statically (see src/app/zk/exchange/[...path]/route.ts).
    "/zk/exchange/[...path]": ["../contracts/managed/exchange/**/*"],
  },
  turbopack: {
    // The exchange contract's already-compiled output
    // (contracts/managed/exchange/) lives one level up from this app, and
    // is imported directly by services/midnight/exchangeContract.ts (see
    // "Use the Compact JavaScript implementation" in the Midnight docs) —
    // Turbopack only resolves files inside its configured root.
    root: path.join(__dirname, ".."),
    resolveAlias: {
      // @midnight-ntwrk/midnight-js-indexer-public-data-provider reads a
      // named `WebSocket` export off `isomorphic-ws` that its own browser
      // build doesn't provide — see src/shims/isomorphic-ws-browser.ts.
      "isomorphic-ws": {
        browser: "./src/shims/isomorphic-ws-browser.ts",
      },
      // @midnight-ntwrk/midnight-js-contracts statically imports `fs` for
      // Node-only file-asset code paths this browser client never takes
      // (it supplies its own zkConfigProvider/providers instead).
      fs: {
        browser: "./src/shims/empty.ts",
      },
    },
  },
};

export default nextConfig;
