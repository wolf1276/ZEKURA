# Zekura Matcher

The confidential off-chain order book and settlement engine for the [Zekura](../README.md) exchange.

`contracts/exchange.compact` is a public **commitment registry** — it never sees, stores, or matches an order's real contents (asset, price, amount, side, owner). The Matcher is the party that does: wallets disclose the full order to it off-chain (after registering the order's commitment on-chain themselves), the Matcher matches crossing orders in-memory, and submits `settle()` transactions to fill them.

```
Frontend
   │
   ▼
Wallet signs order ──────────────┬─────────────────────────┐
   │                             │                          │
   ▼                             ▼                          │
exchange.compact            Matcher Server                  │
(on-chain commitment        (confidential order book,       │
 registry — createOrder)     matching, settlement)           │
   ▲                             │                          │
   │                             │                          │
   └──────────── settle() ───────┴──────────────────────────┘
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full request flow, database schema, and security model; [MATCHER.md](./MATCHER.md) for the matching algorithm and settlement lifecycle in depth; [API.md](./API.md) for the REST/WebSocket reference.

## Tech stack

- **Node.js** 22+, **TypeScript**, **Fastify** (REST API)
- **better-sqlite3** — synchronous SQLite, used for atomic claim transactions
- **ws** — WebSocket event broadcast
- **Zod** — request validation
- **Vitest** — test suite
- **@midnight-ntwrk/midnight-js-contracts** + friends — settlement against the deployed `exchange.compact` contract, reusing this repo's root `src/wallet.ts` / `src/network.ts`

## Prerequisites

- Everything in the [root README](../README.md) (Node ≥ 22, Docker, the Compact compiler) — the Matcher is a workspace member of the root `zekura` package and shares its `node_modules`.
- The exchange contract already compiled (`npm run compile` at the repo root) and deployed to the network you intend to run against (`npm run setup` at the repo root).

## Setup

From the **repo root** (not this directory — `matcher` is an npm workspace, not a standalone package):

```bash
npm install
```

## Run

```bash
cd matcher
npm run dev      # tsx watch — fast local iteration
npm run build    # real tsc build to dist/ (see note below)
npm start        # runs the build
```

> **Build output path note:** because `index.ts` imports the root project's `src/wallet.ts`/`src/network.ts` directly (deliberately, to avoid duplicating ~200 lines of wallet-sync logic — see ARCHITECTURE.md), `tsc`'s inferred `rootDir` spans both `matcher/src` and the repo root's `src`. The compiled entry point therefore lands at `dist/matcher/src/index.js`, not `dist/index.js` — this is what `npm start` runs.

By default the Matcher targets whatever network `.midnight-state.json` (repo root) has active (`undeployed` local devnet unless you've run `npm run network <name>` at the root). Override with environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `MATCHER_PORT` | `4000` | HTTP + WebSocket port |
| `MATCHER_HOST` | `0.0.0.0` | Bind address |
| `MATCHER_DB_PATH` | `./data/matcher.db` | SQLite file path (`:memory:` also works) |
| `MATCHER_LOG_LEVEL` | `info` | pino log level |
| `MATCHER_PRETTY_LOGS` | `true` outside `NODE_ENV=production` | Human-readable vs. structured JSON logs |
| `MATCHER_SETTLEMENT_MAX_RETRIES` | `5` | Transient-failure retry budget per settlement |
| `MATCHER_SETTLEMENT_RETRY_DELAY_MS` | `5000` | Linear backoff base delay |
| `MATCHER_WALLET_SEED` | (falls back to the root project's per-network deployer seed) | The Matcher's own operator wallet — **should be a distinct, independently funded wallet on preview/preprod**, not the deployer's |
| `PRIVATE_STATE_PASSWORD` | local-devnet placeholder | Wallet private-state store password (≥16 chars) |

## Test

```bash
npm run typecheck
npm run lint
npm test              # vitest run
npm run test:coverage # with coverage report (target: >95% lines/statements)
```

The entire suite (155+ tests) runs offline — no devnet, proof server, or wallet required. It exercises real SQLite (`:memory:`), a real in-memory order book/matching engine, and fakes only the two seams that face the live network (`SettleCircuitCaller`, `OnChainOrderReader`) — see ARCHITECTURE.md. `src/index.ts`, which wires those seams to the real Midnight SDK, is intentionally the one file nothing in `tests/` imports.

## Project layout

```
matcher/
  src/
    api/           REST routes (health, orders)
    orderbook/      In-memory order book (Bucket, AssetBook, OrderBook)
    matcher/        Matching engine + price-time-priority strategy
    db/             SQLite schema + repositories
    settlement/      settle() client + retry queue
    websocket/       Event broadcast
    services/        Orchestration (OrderService, SettlementService)
    types/           Domain types
    utils/           Config, logging, validation, the commitment codec
    app.ts           Fastify app factory (testable, deps injected)
    index.ts         Composition root — the only file with real SDK wiring
  tests/             Mirrors src/, plus integration/ and concurrency/
```
