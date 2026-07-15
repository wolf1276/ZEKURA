# Zekura

A privacy-preserving exchange on Midnight — orders are committed on-chain, but what's in them isn't.

This is **Level 1** of the Midnight Builder Challenge: the on-chain order registry foundation only. No Matcher, no settlement execution engine, no treasury, no governance — those are later levels.

## Contract Address

| Network     | Contract Address | Deployed |
|-------------|-------------------|----------|
| Preview     | `7e6fb224e13e12736fdfbaed2d80265105f3a942a88d61a494472c5e11152984` (post-audit build, see [AUDIT.md](./AUDIT.md)) | 2026-07-15 |
| Preprod     | not deployed | — |
| Undeployed (local devnet) | redeploy locally via `npm run setup` | — |

> The address above reflects the `cancelOrder` authorization-bypass fix in
> [AUDIT.md](./AUDIT.md) (the fix changed `cancelOrder`'s circuit logic and
> therefore its verifier key). The previous Preview address
> (`c0acbedfff231c7d9ed8d8015f41881f42c5e113cbf7c9c5bc8efdcb817d8003`) is stale
> and no longer matches `contracts/exchange.compact`.

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

> **Note on scope:** the contract source (`contracts/exchange.compact`) already
> contains `settle()` and `expireOrder()` circuits plus replay protection
> (`settledPairs`) and an event log — these were built ahead of Level 1 and
> are kept because they already work. They are **not** Level 1 deliverables
> (the circuits this level is formally scoped to are `createOrder`,
> `cancelOrder`, and `getOrder`), but a full pre-mainnet security audit
> (see [AUDIT.md](./AUDIT.md)) has since reviewed and hardened the entire
> contract, `settle()`/`expireOrder()` included, and the test suite in
> `tests/exchange.test.ts` now exercises all five circuits.

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
the one on record — proving the caller knows the order's true contents,
without ever writing those contents to the chain.

Knowing an order's contents is necessary but not sufficient to cancel it —
the Matcher also legitimately knows them (a wallet discloses full order
details off-chain for settlement), so `cancelOrder` needs a second,
independent check that only the actual owner can pass. The owner field is a
DApp-specific identity, `deriveOwnerId(secret)` (a domain-separated hash of a
secret only the owner's wallet holds), computed and embedded in `owner` when
the order is created; `cancelOrder` re-derives it from whatever secret the
caller supplies via the `ownerSecretKey` witness and requires the two to
match. This intentionally does **not** use `ownPublicKey()` — see
[AUDIT.md](./AUDIT.md) for why that would be an authorization bypass.

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
  mismatched commitment, a wrong `ownerSecretKey`, a double cancel, and an
  unknown ID — including the regression test proving that knowing an order's
  committed details/blinding (as the Matcher legitimately does) is *not*
  enough to cancel it (see [AUDIT.md](./AUDIT.md), finding P0-1)
- `settle` / `expireOrder` — matching-pair fills, asset/amount/price/side/
  expiry/self-trade rejections, replay-attack and atomicity checks, and
  boundary values (`Uint<128>`/`Uint<64>` max, equal-price crossing,
  all-zero IDs)
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
