import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
