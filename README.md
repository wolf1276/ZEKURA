# Zekura

A privacy-preserving exchange on Midnight — orders are committed on-chain, but what's in them isn't.

This is **Level 1** of the Midnight Builder Challenge: the on-chain order registry foundation only. No Matcher, no settlement execution engine, no treasury, no governance — those are later levels.

## Contract Address

| Network     | Contract Address | Deployed |
|-------------|-------------------|----------|
| Preview     | `c0acbedfff231c7d9ed8d8015f41881f42c5e113cbf7c9c5bc8efdcb817d8003` | 2026-07-15 |
| Preprod     | not deployed | — |
| Undeployed (local devnet) | redeploy locally via `npm run setup` | — |

## Architecture

```
Frontend
   ↓
Wallet signs order
   ↓
exchange.compact  (this repo, Level 1: order registry)
   ↓
Off-chain Matcher   (later level — not implemented here)
   ↓
Settlement          (later level — not implemented here)
```

The **Matcher owns the confidential order book**. `exchange.compact` is *not*
an order book — it never sees, stores, or matches order contents. It is a
public commitment registry: it records that an order with a given ID exists,
what its commitment is, and what lifecycle state it's in, and nothing else.

> **Note on scope:** the deployed contract's source (`contracts/exchange.compact`)
> already contains `settle()` and `expireOrder()` circuits plus replay
> protection (`settledPairs`) and an event log — these were built ahead of
> Level 1 and are kept because they already work, but they are **not**
> Level 1 deliverables and are not exercised by the Level 1 test suite. The
> circuits this level is scoped to are `createOrder`, `cancelOrder`, and
> `getOrder`.

## Privacy Model

**Public** (on the `orders` ledger — anyone can read this):
- `orderId`
- `commitment`
- `state` (`OPEN` / `FILLED` / `CANCELLED` / `EXPIRED`)

**Private** (never written to the ledger, never leaves the owner's wallet
except to whoever they explicitly disclose it to — e.g. the Matcher, off-chain):
- `asset`
- `amount`
- `side` (buy/sell)
- `owner`
- `price`
- `expiresAt`

### What users prove

A wallet creates an order by committing to its private details
(`persistentCommit<OrderDetails>(details, blinding)`) and submitting only
the resulting 32-byte `commitment` on-chain via `createOrder`. Nothing about
the order's contents is ever revealed at creation time.

To cancel an order, the owner's wallet supplies the *same* private details
and blinding factor back to the `cancelOrder` circuit as witnesses. The
circuit recomputes the commitment from those witnesses and checks it against
the one on record — proving the caller actually knows the order's true
contents (and is therefore entitled to act on it) without ever writing those
contents to the chain. It further checks that the disclosed `owner` matches
the caller's own public key before allowing the cancellation to proceed.

## Tech Stack

- **Compact** — Midnight's smart contract language (`contracts/exchange.compact`)
- **Compact compiler** `0.5.1` (language version `>= 0.16`)
- **`@midnight-ntwrk/compact-runtime`** — in-memory circuit execution for tests
- **`@midnight-ntwrk/compact-js`** / **`midnight-js-*`** — deployment, providers, wallet/proof/indexer plumbing
- **TypeScript** + **tsx** — scripts and tests
- **Docker Compose** — local devnet (node, indexer, proof-server) / standalone proof-server for public networks

## Prerequisites

- Node.js ≥ 22
- Docker (with Compose v2)
- The [Compact compiler](https://docs.midnight.network/) at the version this project was scaffolded against (`compact --version`)

## Setup

```bash
npm install
```

## Compile

```bash
npm run compile
```

Compiles `contracts/exchange.compact` to `contracts/managed/exchange/`.

## Run Tests

```bash
npm run test
```

Runs `tests/exchange.test.ts` — an offline suite that drives the compiled
circuits directly through `@midnight-ntwrk/compact-runtime`'s in-memory
`CircuitContext` (no devnet, proof server, or wallet required). Covers:

- `createOrder` — stores the exact commitment supplied, rejects duplicate IDs
- `getOrder` — returns `{commitment, state}`, rejects unknown IDs
- `cancelOrder` — a full real commitment-verification round trip (computes
  `persistentCommit<OrderDetails>` off-chain exactly as the circuit does
  on-chain, and confirms the circuit accepts it), plus rejections for a
  mismatched commitment, a non-owner caller, a double cancel, and an unknown ID
- **Privacy invariant** — after a create + cancel cycle with a live order
  payload in the witness store, asserts the `orders` and `eventLog` ledger
  entries expose *only* their declared public fields (`commitment`/`state`
  and `kind`/`orderId` respectively) and that `amount`, `price`, `owner`,
  `asset`, `isBuy`, and `expiresAt` are `undefined` on every record read
  back from the ledger

## Deploy

```bash
docker compose up -d --wait proof-server   # local proof server for the target network
npm run setup -- --network preview         # compile + deploy in one step
```

`npm run setup` starts the required services for the chosen network,
compiles the contract, and deploys it. On `preview`/`preprod` it prints a
faucet URL and wallet address, then polls for funding before continuing —
fund the printed address from the faucet and it proceeds automatically.

The deployed address is written to `.midnight-state.json` (gitignored) and
printed to the console as `Contract Address: <address>`.

```bash
npm run cli           # read-only CLI: look up an order by ID, check balance
npm run test:e2e       # smoke check against the deployed contract
```

## Initial Idea

_(placeholder — fill in with the original concept writeup)_

## Screenshots

_(placeholder)_
