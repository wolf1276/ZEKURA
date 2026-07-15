# Matcher Architecture

## Contents

- [Component responsibilities](#component-responsibilities)
- [Request flow](#request-flow)
- [Database schema](#database-schema)
- [Security model](#security-model)
- [Concurrency model](#concurrency-model)
- [Deployment](#deployment)

## Component responsibilities

```
api/           Thin Fastify routes — validate, delegate to services/, serialize the response.
orderbook/     Pure in-memory data structure: Bucket (one side of one asset), AssetBook
               (a BUY+SELL Bucket pair), OrderBook (Map<assetKey, AssetBook>). No I/O.
matcher/       MatchingStrategy (price-time-priority eligibility rule) + MatchingEngine
               (orchestrates OrderBook + MatchingStrategy into a Match). No I/O.
db/            better-sqlite3 schema + OrderRepository/MatchRepository. The system of record.
settlement/    SettlementClient (classifies settle() outcomes) + SettlementQueue (generic
               per-key single-flight retry queue). SettlementClient itself has no SDK/network
               imports — it's driven through two small interfaces (SettleCircuitCaller,
               OnChainOrderReader) that src/index.ts implements with real Midnight SDK calls.
websocket/     SocketServer — ws WebSocketServer attached to Fastify's own HTTP server.
services/      OrderService (submission/cancellation/reads, the on-chain commitment check,
               the atomic claim transaction) and SettlementService (drains SettlementQueue,
               persists settlement outcomes, flips order status, broadcasts events).
utils/         Config loading, structured logging (pino), Zod validation schemas, and
               orderDetailsCodec.ts — the OrderDetails wire encoding + commitment recomputation
               ported from ../tests/exchange.test.ts.
app.ts         Builds a Fastify instance from injected dependencies. No SDK/network code —
               fully testable via .inject().
index.ts       Composition root. The *only* file that talks to a real wallet, provider set,
               or the deployed contract. Nothing under tests/ imports it.
```

## Request flow

### Submitting an order (`POST /orders`)

```
1. api/orders.ts        Zod-validates the body (createOrderSchema) → CreateOrderInput
2. OrderService          exists(id)?                                  → 409 DUPLICATE
                         verifyOrderSignature(input, commitment)?      → 422 SIGNATURE_INVALID
                         onChainReader.getOrder(id):
                           NOT_FOUND                                   → 422 NOT_ON_CHAIN
                           commitment mismatch                         → 422 COMMITMENT_MISMATCH
                           state !== OPEN                              → 422 NOT_OPEN_ON_CHAIN
                         isExpired(draft)?                             → 422 EXPIRED
3. OrderService          orderRepo.insert (OPEN) → orderBook.add → broadcast('order.created')
4. MatchingEngine        onOrderArrived(order, lookup, now) — searches ONLY the opposite
                         side's Bucket for this one asset, in best-price/earliest-time order,
                         stopping at the first eligible candidate (or the first price level
                         that no longer crosses — see MATCHER.md).
5. OrderService          if a Match was found: one synchronous db.transaction() CAS-updates
                         both orders OPEN -> MATCHED and inserts the match row; only on
                         success does it evict both from the live OrderBook and broadcast
                         'order.matched' — see "Concurrency model" below.
6. SettlementService     handleMatch(match) → SettlementQueue.enqueue(match.id, job)
```

### Cancelling an order (`DELETE /orders/:id`)

Removes the order from the Matcher's own book and DB only (`OPEN -> CANCELLED`) and broadcasts `order.cancelled`. **This never submits an on-chain `cancelOrder()`** — the Matcher structurally cannot: `cancelOrder()` requires the owner's `ownerSecretKey` witness, which the Matcher is never disclosed (see "Security model"). The order's owner must cancel on-chain themselves; the Matcher stopping consideration of it is a courtesy, not a substitute.

### Settlement (`SettlementService` + `SettlementQueue`)

```
1. attemptSettlement(match, attempt, maxAttempts):
     record the attempt (settlements row insert/update, attempts += 1)
     if attempt == 1: broadcast('order.settling')
     result = SettlementClient.settle({id: buyOrderId}, {id: sellOrderId})
       → findDeployedContract(...).callTx.settle(buyIdBytes, sellIdBytes)   [src/index.ts]
2. on success:            orders -> FILLED, settlements -> SUCCESS, broadcast('order.filled')
3. on failure:             re-read both orders' on-chain state (free indexer read)
   - both already FILLED:  the settle() DID land (result was a false-negative, e.g. a lost
                            response after the tx was already applied) → treat as success
   - both still OPEN
     and retries remain:   settlements -> PENDING, SettlementQueue retries (linear backoff)
   - otherwise
     (state diverged, or
      retries exhausted):  orders -> FAILED, settlements -> FAILED, broadcast('order.failed')
```

`SettlementQueue` is single-flight per `match.id` — a duplicate `handleMatch()` call for a match already in flight is a no-op, which is what makes "never double-settle" hold even under a spurious re-trigger. On process restart, `SettlementService.recoverPendingSettlements()` re-enqueues every match whose orders are still `MATCHED`/`SETTLING` (the queue itself is in-memory only; the DB is the durable record of what's still outstanding).

## Database schema

```
orders                                  matches                          settlements
──────────────────────────              ──────────────────────           ──────────────────────
id            TEXT PK                   id             TEXT PK           id           TEXT PK
asset_is_left INTEGER                   buy_order_id   TEXT → orders.id  match_id     TEXT → matches.id
asset_left    TEXT                      sell_order_id  TEXT → orders.id  status       PENDING|SUCCESS|FAILED
asset_right   TEXT                      asset_key      TEXT              tx_id        TEXT (nullable)
asset_key     TEXT   ── idx             price          TEXT              error        TEXT (nullable)
side          BUY|SELL ── idx           amount         TEXT              attempts     INTEGER
price         TEXT                      matched_at     INTEGER           created_at   INTEGER
amount        TEXT                                                        updated_at   INTEGER
commitment    TEXT
owner_id      TEXT
signature     TEXT                     Indexes: matches(buy_order_id), matches(sell_order_id),
status        TEXT   ── idx             settlements(match_id), settlements(status)
created_at    INTEGER ── idx
expires_at    TEXT
```

`price`/`amount`/`expires_at` are `TEXT` (decimal strings), not `INTEGER` — the contract's `Uint<128>` price/amount fields exceed SQLite's 64-bit `INTEGER` range. They round-trip through `BigInt(text)` in `OrderRepository`. `orders` holds the full disclosed payload including `signature` (the blinding factor) — this table is local-only (gitignored), never written to the chain.

## Security model

**The `signature` field is not a digital signature — it's the order's blinding factor, and "verifying" it means recomputing the contract's own commitment.** The contract's sole authentication primitive is `persistentCommit<OrderDetails>(details, blinding) == commitment`: a hash preimage proof. Only a party that actually knows an order's true `(OrderDetails, blinding)` pair can produce one that recomputes to a given on-chain commitment. `utils/orderDetailsCodec.ts` ports the exact wire encoding from `../tests/exchange.test.ts` to recompute this off-chain, and `OrderService.submitOrder` requires the recomputed value to equal **both** the client-supplied `commitment` **and** the commitment already recorded on-chain for that `orderId` (read for free via the indexer, never a paid `getOrder()` transaction). This closes the loop without introducing a second, unrelated cryptographic scheme — consistent with Midnight's own guidance to prefer hash-based proof-of-knowledge over inventing signatures.

**The Matcher never holds — and never needs — an owner's `ownerSecretKey`.** Per the contract's own audit (`../AUDIT.md`), the Matcher is legitimately disclosed full `OrderDetails` + blinding for settlement, but never the secret behind an order's `owner` identity. `settle()`'s circuit body only ever calls the `orderDetails`/`orderBlinding` witnesses (never `ownerSecretKey` — that's exclusive to `cancelOrder`), so `settlement/SettlementClient.ts`'s witness object supplies real implementations for the first two and one that throws for the third. This is also why `DELETE /orders/:id` can only be a book/DB operation, never an on-chain cancellation (see "Request flow" above).

**Trust boundary summary:**

| Party | Trusted for | Not trusted for |
|---|---|---|
| Order owner's wallet | Its own `OrderDetails` + blinding + `ownerSecretKey`. Submits `createOrder()` on-chain directly (the Matcher never does). | Nothing about other orders. |
| Matcher | Disclosed `OrderDetails` + blinding for orders it holds (needed for `settle()`). Its own funded operator wallet, distinct from any user's. | Any order's `ownerSecretKey` — structurally never disclosed to it. |
| Any HTTP/WS client | Reading `GET /orders/*`, submitting `POST /orders` (validated against the chain before being trusted), receiving broadcasts. | Nothing else — no admin surface exists. |

## Concurrency model

The Matcher is a single Node.js process; `better-sqlite3` is synchronous. The claim step — checking both matched orders are still `OPEN`, flipping them to `MATCHED`, and inserting the `matches` row — runs inside one `db.transaction()` invoked with **no `await` in between**, so no other request can interleave and double-claim either order; JS's single-threaded event loop guarantees that synchronous block runs to completion before anything else touches the same repositories. `OrderRepository.updateStatus` additionally takes an optional compare-and-swap guard (`expectedCurrentStatuses`) as defense-in-depth, and `OrderRepository.insert`'s `PRIMARY KEY` constraint is the actual source of truth for duplicate-id detection (the `exists()` pre-check is only a fast path — it runs before the one genuine `await` in `submitOrder`, so two concurrent submissions of the same id can both pass it; the constraint violation on the second `insert()` is caught and translated to the same `DUPLICATE` result). Settlement submissions are serialized per-match by `SettlementQueue`'s single-flight guarantee, so a retried settlement can never race a freshly triggered one for the same pair.

## Deployment

The Matcher is an npm workspace member of the root `zekura` package (see the root `package.json`'s `workspaces` field), sharing one `node_modules` and importing the root's `src/wallet.ts`/`src/network.ts` and compiled contract artifacts (`../contracts/managed/exchange`) directly rather than duplicating them. It requires:

1. The contract compiled and deployed (root `npm run compile && npm run setup`).
2. A local proof server reachable at the configured network's `proofServer` URL (`docker compose up -d` at the repo root for local devnet; a standalone proof server for preview/preprod — see the root README).
3. Its own funded operator wallet (`MATCHER_WALLET_SEED`) with registered DUST — `settle()` is a real transaction and costs gas like any other.
4. A writable path for its SQLite file (`MATCHER_DB_PATH`) — this is the Matcher's durable state and should be backed up/persisted across restarts; `recoverPendingSettlements()` depends on it to resume any settlement that was in flight when the process last stopped.

See the root README for network configuration (`npm run network <name>`) and this package's README for Matcher-specific environment variables.
