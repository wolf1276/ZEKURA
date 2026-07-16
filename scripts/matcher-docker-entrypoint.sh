#!/usr/bin/env sh
# Redirects the Matcher's wallet-resync cache (normally written next to
# contracts/exchange.compact — see findRepoRoot in matcher/src/index.ts) onto
# the Railway volume mounted at /data, so it survives redeploys instead of
# forcing a full resync from genesis every time.
set -eu

if [ -d /data ]; then
  mkdir -p /data/wallet-state
  rm -rf /app/.midnight-wallet-state
  ln -sfn /data/wallet-state /app/.midnight-wallet-state
fi

exec node matcher/dist/matcher/src/index.js
