# Zekura

> This project is built on the Midnight Network.

A privacy-preserving exchange on Midnight — orders are committed on-chain, matched
confidentially off-chain, and settled on-chain, without ever revealing asset,
amount, side, price, or owner identity to a public observer.

Zekura is a full three-tier system:

1. **`contracts/exchange.compact`** — the on-chain commitment registry and
   settlement contract.
2. **`matcher/`** — the off-chain Matcher: the confidential order book,
   price-time-priority matching engine, and `settle()` submitter.
3. **`web/`** — the trading UI: wallet connection, order submission, live
   order/activity feeds, and an on-chain privacy-proof panel.

All three are implemented, tested, and have been exercised together against
live Midnight networks (Preview and Preprod) — see
["End-to-end verification"](#end-to-end-verification) and
[Deployment.md](./Deployment.md).

## Architecture

```
                     ┌──────────────────────────────────────────┐
                     │                web/ (Next.js)             │
                     │  wallet connect · order form · live feeds  │
                     └───────────────┬─────────────────┬─────────┘
                                     │                 │
                     createOrder /   │                 │  REST + WebSocket
                     cancelOrder     │                 │  (orders, trades,
                     (signed via     ▼                 │   stats, order book)
                     wallet extension,      ┌───────────▼─────────────┐
                     proven, submitted)     │      matcher/            │
                                            │  confidential order book, │
                     ┌──────────────────────┤  price-time-priority      │
                     │                       │  matching, settle()       │
                     ▼                       │  submission               │
        ┌─────────────────────────┐          └─────────────┬─────────────┘
        │  exchange.compact        │◀──────── settle() ─────┘
        │  (public commitment      │
        │   registry + settlement) │
        └─────────────────────────┘
```

`exchange.compact` is **not** an order book — it never sees, stores, or
matches order contents. It records that an order with a given ID exists,
what its commitment is, and what lifecycle state it's in (`OPEN` / `FILLED`
/ `CANCELLED` / `EXPIRED`), nothing else. The **Matcher owns the
confidential order book**: wallets disclose full order details to it
off-chain (after registering the order's commitment on-chain themselves),
it matches crossing orders in memory, and submits `settle()` transactions
to fill them. The **web app** is the human-facing client for both: it talks
to the contract directly (via the Midnight DApp Connector API and a wallet
extension) for `createOrder`/`cancelOrder`, and to the Matcher's REST/WS API
for order book, activity, and settlement status.

See [matcher/ARCHITECTURE.md](./matcher/ARCHITECTURE.md) for the Matcher's
request flow, database schema, and security model in depth, and
[AUDIT.md](./AUDIT.md) for the contract's full security review.

## Contract Address

| Network     | Contract Address | Deployed |
|-------------|-------------------|----------|
| Preview     | `7e6fb224e13e12736fdfbaed2d80265105f3a942a88d61a494472c5e11152984` (post-audit build, see [AUDIT.md](./AUDIT.md)) | 2026-07-15 |
| Preprod     | `7d1f1f67c3ccb1f757a0c1a1c2ef726946db724e2f92f2e0de7c73915e7eb9d1` (post-audit build, see [AUDIT.md](./AUDIT.md)) | 2026-07-16 |
| Undeployed (local devnet) | redeploy locally via `npm run setup` | — |

See [Deployment.md](./Deployment.md) for the full deployment record (deployer
addresses, verification steps run, and current production status) for both
networks. Both Preview and Preprod run the identical audited contract build.

## Privacy Model

The contract's only on-chain state is the `orders` ledger — a
`Map<orderId, {commitment, state}>` — plus a replay-protection set
(`settledPairs`) and an append-only event log (`eventLog`) that carries only
`{kind, orderId}`. Everything else about an order lives off-chain, in the
owner's wallet and (once disclosed for settlement) the Matcher's database.

### What observers can learn

Anyone reading the public ledger, indexer, or a submitted transaction can see:

- That an order with a given `orderId` **exists**, and its 32-byte
  **commitment** (a SHA-256-family hash — reveals nothing about its
  contents without the preimage).
- Its **lifecycle state**: `OPEN`, `FILLED`, `CANCELLED`, or `EXPIRED`, and
  the **order of state transitions** (i.e., that some `settle()` or
  `cancelOrder()` call happened, and roughly when).
- That a `createOrder`/`cancelOrder`/`settle`/`expireOrder` transaction was
  submitted, by which address, at which block — standard Midnight
  transaction metadata is not hidden by this contract.
- The **total count** of orders and their commitments (the `orders` map is
  fully enumerable), which lets an observer infer overall exchange volume
  in *number of orders*, but not their sizes, prices, or sides.

### What remains confidential

Never written to the ledger, never leaves the owner's wallet except to
whoever they explicitly disclose it to (the Matcher, off-chain, for
settlement):

- **`asset`** — which token/pair the order trades
- **`amount`** — order size
- **`side`** — buy or sell
- **`owner`** — a DApp-specific identity (`deriveOwnerId(secret)`), never
  the caller's real Zswap public key or wallet address
- **`price`** — limit price
- **`expiresAt`** — order expiry (except indirectly, via the public fact
  that an `expireOrder()` call succeeded)

A network observer therefore cannot reconstruct the order book, cannot see
who is trading what against whom, and cannot correlate two orders as
belonging to the same owner (the owner field is a domain-separated hash of
a per-DApp secret, not a reusable public key). The Matcher — the one party
that *does* see full order contents, by design, in order to match and
settle them — is explicitly **not** trusted to act as an order's owner: see
"What users prove" below and [AUDIT.md](./AUDIT.md)'s P0 finding for why
that boundary needed a dedicated fix.

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
independent check that only the actual owner can pass. The owner field is
`deriveOwnerId(secret)` (a domain-separated hash of a secret only the
owner's wallet holds), computed and embedded in `owner` when the order is
created; `cancelOrder` re-derives it from whatever secret the caller
supplies via the `ownerSecretKey` witness and requires the two to match.
This intentionally does **not** use `ownPublicKey()` — see
[AUDIT.md](./AUDIT.md) for why that would be an authorization bypass.

**Observable, not just documented:** once an order is submitted through the
web app, the Trade page's "Verify privacy on-chain" panel
(`web/src/services/midnight/orderVerification.ts` +
`web/src/components/trade/privacy-proof-panel.tsx`) fetches that order's
*actual* live ledger record from the connected network's indexer and shows
it side by side with the order's real private fields the app already holds
locally — so this privacy split is something you can click and confirm, not
only read about.

## Tech Stack

- **Compact** — Midnight's smart contract language (`contracts/exchange.compact`)
- **Compact toolchain** `0.31.1` (compiler version; the `compact` CLI tool
  itself reports `0.5.1` — these are two independent version numbers, see
  `contracts/managed/exchange/compiler/contract-info.json`), language
  version `0.23.0` (contract pragma requires `>= 0.16`)
- **`@midnight-ntwrk/compact-runtime`** — in-memory circuit execution for tests
- **`@midnight-ntwrk/compact-js`** / **`midnight-js-*`** — deployment, providers, wallet/proof/indexer plumbing
- **TypeScript** + **tsx** — scripts and tests
- **Fastify**, **better-sqlite3**, **ws**, **Zod** — the Matcher server (see [matcher/README.md](./matcher/README.md))
- **Next.js**, **React**, **Tailwind** — the web app (see [web/README.md](./web/README.md))
- **Vitest** — matcher and web test suites; a hand-rolled assertion runner for the contract suite
- **Docker Compose** — local devnet (node, indexer, proof-server) / standalone proof-server for public networks

## Prerequisites

- Node.js ≥ 22
- Docker (with Compose v2)
- The [Compact compiler](https://docs.midnight.network/) at the version this project targets (`compact update 0.31.1`; `compact --version` reports the CLI tool version, not the compiler version — see "Tech Stack" above)

## Setup

```bash
npm install          # installs the root + matcher workspace (matcher is an npm workspace member)
cd web && npm install # web is a standalone package with its own lockfile
```

## Compile

```bash
npm run compile
```

Compiles `contracts/exchange.compact` to `contracts/managed/exchange/`.

## Run Tests

Three independent, offline test suites — no devnet, proof server, or wallet
required for any of them — cover **238 tests** across the whole system:

```bash
npm run test                    # root: 34 tests — contracts/exchange.compact
npm run test --workspace=matcher # matcher: 185 tests — order book, matching, settlement, API
cd web && npm run test          # web: 19 tests — commitment codec, formatting, order-status logic
```

**Root (`tests/exchange.test.ts`, 34 tests)** — drives the compiled circuits
directly through `@midnight-ntwrk/compact-runtime`'s in-memory
`CircuitContext`. Covers `createOrder`/`getOrder`/`cancelOrder` positive and
negative paths (including the owner-identity regression test for
[AUDIT.md](./AUDIT.md)'s P0 finding), `settle`/`expireOrder` matching,
mismatches, replay, atomicity, and boundary values, and the **privacy
invariant** test — asserting that after a create+cancel cycle, the `orders`
and `eventLog` ledger entries expose *only* their declared public fields and
never leak `amount`, `price`, `owner`, `asset`, `isBuy`, or `expiresAt`.

**Matcher (`matcher/tests/`, 185 tests, >95% line coverage enforced)** —
the in-memory order book, price-time-priority matching engine, SQLite
persistence, settlement retry queue, REST/WebSocket API, and commitment
verification against on-chain state, all exercised with real SQLite
(`:memory:`) and a real matching engine; only the two seams that face the
live network (`SettleCircuitCaller`, `OnChainOrderReader`) are faked. See
[matcher/README.md](./matcher/README.md).

**Web (`web/tests/`, 19 tests)** — the browser-side `OrderDetails`
commitment codec (determinism and no-collision checks on the exact
`persistentCommit` encoding a wallet must reproduce bit-for-bit before
calling `createOrder`) and the pure formatting/order-status logic the UI
renders from.

```bash
npm run build                    # root: tsc --noEmit
npm run lint --workspace=matcher # matcher: eslint
npm run build --workspace=matcher # matcher: tsc build
cd web && npm run lint           # web: eslint
cd web && npm run build          # web: production Next.js build
```

## CI/CD

[`.github/workflows/ci.yml`](./.github/workflows/ci.yml) runs on every push
to `main` and every pull request. A single job installs the pinned Compact
toolchain, then for each of the three packages: compiles/typechecks, lints
(matcher, web), runs its full test suite, and (web) produces a real
production build. A push that breaks compilation, a type error, a lint
violation, a failing test, or a broken production build in *any* of the
three packages fails CI.

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

## Deployment

Both Preview and Preprod already have live, audited deployments — see the
[Contract Address](#contract-address) table above. Full deployment history
(deployer addresses, funding, every verification step run before and after
each deploy, and a recorded live trade round trip on Preprod) lives in
[Deployment.md](./Deployment.md), not duplicated here. To deploy fresh
(a new network, or after a contract change that alters a circuit's verifier
key — see [AUDIT.md](./AUDIT.md)'s "Remaining Risks" for why that matters),
use the `npm run setup -- --network <preview|preprod>` command above, then
update `web/.env.local`'s matching `NEXT_PUBLIC_EXCHANGE_CONTRACT_ADDRESS_*`
variable and this README's Contract Address table.

## Wallet

The frontend (`web/`) connects through the standard Midnight DApp Connector
API (`@midnight-ntwrk/dapp-connector-api`), the same interface every
Midnight-compatible wallet extension implements. Two wallets are recognized
by name (`web/src/wallet/walletRegistry.ts`), any other connector-compatible
wallet injected under `window.midnight` is picked up generically:

- **1AM Wallet** (`window.midnight['1am']`) — recommended, shielded by
  default, implements in-browser proving (`getProvingProvider()`).
- **Lace** (`window.midnight.mnLace`) — does not implement
  `getProvingProvider()`; the app falls back to the local proof server
  (`NEXT_PUBLIC_PROOF_SERVER_URL`, default `http://127.0.0.1:6300`) for
  Lace sessions only (`web/src/services/midnight/exchangeContract.ts`).

`web/src/wallet/WalletProvider.tsx` covers the full connection lifecycle:

- **Connect** — via the wallet picker modal; the `connect()` call happens
  synchronously inside the click so the extension's approval pop-up isn't
  blocked, with a generous timeout as a safety net against a hung extension.
- **Disconnect** — clears local session state and the "reconnect on load"
  flag.
- **Reconnect** — if the browser was previously connected, the same wallet
  is silently reconnected on page load once the Network Manager has settled
  on a network; a rejected/failed silent reconnect falls back to `idle`
  (the manual picker) without surfacing an error, since there's no user
  gesture to show one against.
- **Loading / error / wrong-network states** — `WalletStatus` models
  `idle` / `connecting` / `connected` / `unsupported-network` /
  `disconnected` / `unavailable` / `error` explicitly; connector failures
  (rejected request, blocked permission, disconnected mid-call, etc.) are
  normalized into a `WalletError` with a user-facing message
  (`web/src/wallet/walletConnector.ts`).
- **Network sync** — the DApp Connector v4 API has no push events for
  network changes, so `getConnectionStatus()` is polled; whatever network
  the wallet reports is adopted as the app's own (`web/src/network/`), so
  there is no "wrong network" state to get stuck in — only
  `unsupported-network` for a wallet-reported id Zekura has no
  `NetworkConfig` for (i.e. anything other than `preview`/`preprod`).

## Preview

Preview is the default network the web app runs against. To run against it:

```bash
cd web
cp .env.example .env.local   # if you haven't already
npm install
npm run dev
```

`NEXT_PUBLIC_EXCHANGE_CONTRACT_ADDRESS_PREVIEW` in `web/.env.local` must
point at a live Preview deployment (see the Contract Address table above).
Point your wallet extension at Preview and connect — the app adopts
whatever network the wallet reports (see "Wallet" above), it isn't chosen
by an env var at runtime.

## Preprod

Same app, pointed at Preprod instead — switch networks from the wallet
picker/Network Manager in the navbar, or start fresh against Preprod
directly:

```bash
cd web
npm run dev
```

`NEXT_PUBLIC_EXCHANGE_CONTRACT_ADDRESS_PREPROD` in `web/.env.local` must
point at a live Preprod deployment (see the Contract Address table above —
currently `7d1f1f67c3ccb1f757a0c1a1c2ef726946db724e2f92f2e0de7c73915e7eb9d1`).
Switch your wallet extension to Preprod; the app follows. For read-only
sanity checks against Preprod without a browser at all, use
`npm run test:e2e -- --network preprod` from the repo root (see
Deployment.md).

## Demo Instructions

A full, real (non-mocked) trade round trip through the web app:

1. **Start infrastructure**: `docker compose up -d --wait proof-server`
   (repo root), then start the Matcher (`cd matcher && npm run dev`) and the
   web app (`cd web && npm run dev`).
2. **Connect a wallet** (1AM or Lace) via the navbar — see "Wallet" above
   for what each connection state looks like.
3. **Submit an order** on the Trade page — this signs and submits a real
   `createOrder(orderId, commitment)` circuit call through the connected
   wallet (`web/src/services/midnight/exchangeContract.ts`), no mocks. The
   wallet's approval pop-up is the actual proof/sign/submit step.
4. **Watch it propagate live**: the Trade page's order status timeline, the
   Orders page, the Activity feed, and the Overview page all update
   automatically from the same Matcher WebSocket feed
   (`web/src/services/matcher/matcherClient.ts`) — no manual refresh.
5. **Verify the privacy property**: once the order appears, use the
   "Verify privacy on-chain" panel under the order status timeline. It
   fetches the order's *actual* live ledger record from the connected
   network's indexer and shows it side by side with the order's real
   private fields (side, price, amount, expiry) that this app already holds
   locally — observably confirming that only `{commitment, state}` ever
   reached the chain (see "Privacy Model" above and
   `web/src/services/midnight/orderVerification.ts`).

To see a match and settlement specifically (rather than a single order),
repeat step 3 with a second, crossing order (opposite side, crossing
price, same asset) from a second wallet/browser profile — the Matcher
matches it against the resting order and submits `settle()` automatically;
both orders' status timelines advance to `FILLED` without either wallet
doing anything further.

## End-to-end verification

The full flow — **wallet → trade → Matcher → settlement → UI updates** —
has been exercised at two different levels, and this section reports both
honestly rather than overstating either:

- **Fully verified, live, on real Preprod infrastructure** (see
  [Deployment.md](./Deployment.md) for the complete transcript): two
  on-chain `createOrder()` calls submitted directly, both accepted by the
  live Matcher (which independently recomputed and cross-checked each
  commitment against the indexer), matched by the price-time-priority
  engine, settled with a real on-chain `settle()` transaction, and the
  resulting `FILLED` state confirmed by an independent direct ledger read
  (not just trusting the Matcher's own database). Three live failure-path
  checks (forged commitment, unregistered order, replay of an
  already-filled order) were also exercised and rejected correctly. The
  Matcher's `GET /trades`/`GET /stats` endpoints — what the web app's
  Activity and Overview pages consume — were confirmed to reflect the fill.
- **Not yet exercised**: a literal browser session with a real wallet
  extension (1AM/Lace) driving a click-through of the Demo Instructions
  above end to end. Every code path that flow would exercise has either
  been driven directly (same SDK calls, same providers) or covered by the
  238 automated tests, and the web app has been verified to build and
  render every route cleanly (production build + a headless-browser render
  pass across `/trade`, `/orders`, `/activity`, `/dashboard`, zero console
  errors) — but the actual wallet-extension approval pop-up flow requires a
  human with a funded wallet extension installed, which this automated
  verification pass cannot simulate.

## Production readiness

- **Contract**: audited ([AUDIT.md](./AUDIT.md), one P0 fixed), deployed
  identically to Preview and Preprod, 34/34 tests passing.
- **Matcher**: 185/185 tests passing, >95% line coverage enforced in CI-run
  coverage thresholds, typecheck and lint clean.
- **Web**: 19/19 tests passing, typecheck and lint clean, production build
  succeeds.
- **CI**: compiles and tests all three packages on every push (see "CI/CD"
  above).
- **Mainnet**: out of scope — no Mainnet `NetworkConfig` exists in this repo
  (`src/network.ts` / `web/src/network/networkConfig.ts` define only
  `preview`/`preprod`).

See [AUDIT.md](./AUDIT.md) and [Deployment.md](./Deployment.md) for the full
security and deployment record.

## Initial Idea

Zekura started from a simple question: can you build a real limit-order
exchange — continuous matching, cancellation, expiry, multiple concurrent
orders and owners — on Midnight, where the chain never learns what's being
traded, at what price, or by whom, and where the one off-chain party that
*does* need to see order contents (the Matcher, to match and settle them)
is cryptographically prevented from acting as anyone's owner?

The closest official Midnight example is the
[Private Reserve Auction](https://docs.midnight.network/examples/contracts/private-reserve-auction)
contract — hiding a reserve price while keeping bid amounts public, using
the same `persistentHash`-based DApp-specific-identity pattern
(`getDappPubKey`/`deriveOwnerId`) Zekura's `cancelOrder` fix relies on. But
a sealed-bid auction is a single-round, single-item, single-winner
mechanism: bids are submitted once, the auction closes, one price is
revealed. Zekura is a **continuous, multi-party, multi-order exchange** —
orders can be created, cancelled, or matched at any time against any number
of counterparties, with replay protection and a persistent state machine
per order rather than a one-shot reveal. It sits closer to the Finance &
DeFi orderbook-DEX category in Midnight's ecosystem (alongside projects
like [SilentLedger](https://github.com/bytewizard42i/SilentLedger) and
[LunarSwap](https://github.com/OpenZeppelin/midnight-apps)) than to a
single-round auction — see "Product mapping" below for the full comparison.

## Product mapping

Zekura does not map cleanly onto a single official Midnight example
contract, because it composes patterns from several of them into one
system:

| Pattern | Where Zekura uses it | Closest official reference |
|---|---|---|
| Commitment-then-reveal privacy | `createOrder` commits, contents only ever disclosed off-chain | [Private Reserve Auction](https://docs.midnight.network/examples/contracts/private-reserve-auction) |
| DApp-specific pseudonymous identity (never a real wallet key) | `deriveOwnerId(secretKey)` | Private Reserve Auction's `getDappPubKey`; also the pattern Midnight's own `zk-loan`/`bboard` tutorials use |
| Witness-verified reveal against a stored commitment | `cancelOrder`/`settle` re-derive `persistentCommit` and assert equality | [ZK Loan DApp](https://docs.midnight.network/tutorials/zk-loan), [Bulletin board DApp](https://docs.midnight.network/tutorials/bboard) |
| Off-chain matching engine + on-chain settlement split | `matcher/` vs. `exchange.compact` | No single official example — closest ecosystem analogues are orderbook-DEX submissions like SilentLedger/LunarSwap (Finance & DeFi) |

If a single closest official product proposal is required, **Sealed-Bid
Auction** is the right anchor to name, since Zekura's authorization and
commitment-hiding design is a direct extension of that pattern's
techniques — but Zekura's actual mechanism (continuous limit-order
matching across an arbitrary number of open orders, rather than one
sealed-bid round with one reveal) exceeds what that example demonstrates.
It is best described as **"a Private Reserve Auction pattern, generalized
from one sealed round to a continuously operating order book."**

## Screenshots

_(placeholder — see the "Demo Instructions" above to run the app locally and
capture your own; a live UI walkthrough requires a wallet extension, which
this repo's automated verification cannot provide)_
