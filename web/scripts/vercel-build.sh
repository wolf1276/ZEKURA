#!/usr/bin/env bash
# Vercel build entrypoint (invoked via the `vercel-build` npm script with the
# Vercel project's Root Directory set to `web/`).
#
# contracts/managed/exchange/ (the compiled exchange.compact output that
# web/src/services/midnight/* and the /zk/exchange/[...path] route import
# from one level up) is gitignored — it's produced by the Midnight `compact`
# compiler, never committed. CI compiles it in a dedicated job before
# building web (see .github/workflows/ci.yml); Vercel has no such
# pre-build job, so this script reproduces those steps inline.
set -euo pipefail

COMPACT_VERSION="0.31.1"
REPO_ROOT="$(cd .. && pwd)"

echo "==> Installing root workspace dependencies"
(cd "$REPO_ROOT" && npm ci)

if ! command -v compact >/dev/null 2>&1; then
  echo "==> Installing Compact compiler toolchain"
  curl --proto '=https' --tlsv1.2 -LsSf https://github.com/midnightntwrk/compact/releases/latest/download/compact-installer.sh | sh
fi
export PATH="$HOME/.local/bin:$PATH"

echo "==> Pinning Compact compiler to $COMPACT_VERSION"
compact update "$COMPACT_VERSION"

echo "==> Compiling exchange.compact"
(cd "$REPO_ROOT" && compact compile contracts/exchange.compact contracts/managed/exchange)

echo "==> Building Next.js app"
next build
