# Matching Engine & Settlement

## Order book structure

```
OrderBook                         Map<assetKey, AssetBook>
  └─ AssetBook (per asset)        { buy: Bucket, sell: Bucket }
       └─ Bucket (per side)       sorted price levels, best price first for that side:
                                     BUY  bucket → highest price first
                                     SELL bucket → lowest price first
                                   each level: a FIFO array of order ids (time priority)
                                   + an orderId → price map for O(1) removal
```

`assetKey` (`types/Asset.ts`) is the traded asset's real unshielded token color — a plain `Bytes<32>` hex string, identical to the on-chain `OrderDetails.asset` field and the Treasury's own `assetKey`. The contract's `settle()` compares `buyDetails.asset == sellDetails.asset` directly, so the Matcher's own partition key uses the same direct equality, guaranteeing anything it considers "matched" will actually be accepted by `settle()`.

Every operation is either O(1) (`add`, `has`) or bounded to one asset's one bucket (`remove`, `oppositeBucket`) — the book is never scanned wholesale, and `Bucket.iterateInPriorityOrder()` is a lazy generator so a caller can stop at the first hit without materializing the rest.

## Matching algorithm

Triggered **only** by two call sites — a new order arriving (`OrderService.submitOrder`) or an order being removed (`OrderService.cancelOrder`, which only evicts and never re-triggers a search, since removing a resting order cannot create a new crossing). There is no poller, no timer, no background scan.

```
MatchingEngine.onOrderArrived(incoming, lookup, now):
  opposite = orderBook.oppositeBucket(incoming)      // this asset, other side — O(1)
  return strategy.findMatch(incoming, opposite, lookup, now)
```

`PriceTimePriorityStrategy.findMatch` walks the opposite bucket in its natural (best-first) order:

```
for candidateId in oppositeBucket.iterateInPriorityOrder():
  candidate = lookup(candidateId)
  if candidate is missing:                      continue   (stale entry, defensive)
  if !crosses(incoming, candidate):              break      ← sorted; nothing further can cross either
  if candidate.ownerId == incoming.ownerId:      continue   (no self-trades)
  if candidate.status != OPEN:                   continue
  if candidate is expired:                       continue
  if candidate.amount != incoming.amount:        continue   (no partial fills — contract requires exact match)
  return candidate                                          ← first eligible = best eligible, stop here
return null
```

`crosses(buy, sell) = buy.price >= sell.price` — the same `>=` the contract's `settle()` itself asserts. Because the bucket is sorted best-to-worst for its side, the `break` on the first non-crossing level is a real optimization (not just an eligibility check): once one level fails to cross, every worse level does too, so the algorithm never wastes time on price levels that couldn't possibly match — regardless of how many other reasons entries within a *crossing* level might be skipped for.

**Why "first eligible" needs no separate ranking step:** the bucket's iteration order already *is* the ranking (best price, then earliest arrival within a price level), so the eligibility filter above is the entire algorithm — there's no second pass to find "the best among eligible candidates."

### Skip-condition summary (from the brief)

| Condition | Where enforced |
|---|---|
| Same owner | `PriceTimePriorityStrategy` (self-trade guard) |
| Cancelled / Filled / not OPEN | `PriceTimePriorityStrategy` (`status !== 'OPEN'`) |
| Expired | `PriceTimePriorityStrategy` (`isExpired`, lazily materialized to `EXPIRED` status the next time the order is read — see `OrderService.materializeExpiry`) |
| Different asset | Structural — the two sides are never in the same `Bucket` pair to begin with |
| Amount mismatch | `PriceTimePriorityStrategy` (exact-equality, no partial fills) |
| Price non-crossing | `PriceTimePriorityStrategy` (`crosses`, with early `break`) |

## Settlement

`settle(buyOrderId, sellOrderId)` takes **no order data as arguments** — it re-derives both orders' full private details from `orderDetails`/`orderBlinding` witnesses supplied by whoever calls it, and asserts they hash back to the on-chain commitments. `settlement/SettlementClient.ts`'s `buildExchangeWitnesses` supplies those witnesses, backed directly by `OrderRepository` (the same disclosed data `OrderService` already verified at submission time):

```
orderDetails(context, orderId):  [context.privateState, toOrderDetailsValue(orderRepo.findById(orderId))]
orderBlinding(context, orderId): [context.privateState, hexToBytes32(orderRepo.findById(orderId).signature)]
ownerSecretKey(context):         throws — never called by settle(), and the Matcher never holds one
```

One witnesses object, built once at startup, serves every `settle()` call for the process's lifetime — the witness function receives whichever `orderId` the circuit needs at call time, so no per-call wiring is required.

`SettlementClient.settle()` never throws — it classifies whatever happens into a `SettlementAttemptResult`:

- **`success`** — `callTx.settle()` resolved; the tx landed and the contract's `assert`s all passed.
- **`callFailed`** — a `CallTxFailedError` (guaranteed- or fallible-phase failure per Midnight's transaction model): the tx was evaluated and did **not** succeed. Carries the on-chain `TxStatus`.
- **`transientError`** — anything else (proof-server unreachable, network error, wallet balancing failure) — nothing was ever submitted to the chain.

`SettlementService` (see ARCHITECTURE.md's "Settlement" sequence) turns that classification into retry-or-terminal policy, re-checking on-chain state after any failure so it can distinguish "transient, safe to retry" from "already succeeded despite the error" from "permanently diverged, mark FAILED" — never retrying a business-rule rejection (which would only fail identically again) and never leaving a truly-settled pair reported as failed just because the confirmation was lost in transit.

### Why `settle()` itself can never double-settle

The contract's own replay protection (`settledPairs` nullifier set, plus the `OPEN -> FILLED` state machine being one-way) makes a second `settle()` on an already-filled pair fail cleanly on-chain with no state change — see `../AUDIT.md`'s "Replay Protection Review". The Matcher's `SettlementQueue` single-flight guarantee (one in-flight job per `match.id`) exists to avoid ever *wasting* a redundant call, not because a redundant call would be unsafe.
