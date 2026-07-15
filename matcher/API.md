# API Reference

Base URL: `http://<host>:<port>` (defaults `0.0.0.0:4000`, see README.md). All bodies are JSON. `price`/`amount`/`expiresAt` travel as **decimal strings**, not numbers — they can exceed `Number.MAX_SAFE_INTEGER` (the contract's fields are `Uint<128>`/`Uint<64>`).

## Order object (as returned by the API)

```jsonc
{
  "id": "64 lowercase hex chars",           // Bytes<32> orderId
  "asset": { "isLeft": true, "left": "64 hex", "right": "64 hex" }, // Either<Bytes<32>,Bytes<32>>
  "side": "BUY" | "SELL",
  "price": "1000",                          // decimal string
  "amount": "50",                           // decimal string
  "commitment": "64 hex",                   // persistentCommit<OrderDetails>(details, signature)
  "ownerId": "64 hex",                      // deriveOwnerId(ownerSecretKey()) — never the secret itself
  "status": "OPEN" | "MATCHED" | "SETTLING" | "FILLED" | "CANCELLED" | "EXPIRED" | "FAILED",
  "createdAt": 1700000000000,               // Matcher-local receipt time, unix ms
  "expiresAt": "9999999999"                 // decimal string, unix seconds
}
```

Note `signature` (the order's blinding factor) is accepted on submission but **not** echoed back — it's private material the Matcher needs for settlement, not something worth repeating in every response.

## `POST /orders`

Discloses a fully-signed order to the Matcher. The order's on-chain `createOrder()` must already have been submitted and finalized — this endpoint verifies the disclosure against it, it does not create anything on-chain itself.

**Body:**

```jsonc
{
  "id": "64 hex",
  "asset": { "isLeft": true, "left": "64 hex", "right": "64 hex" },
  "side": "BUY",
  "price": "1000",
  "amount": "50",
  "commitment": "64 hex",
  "ownerId": "64 hex",
  "signature": "64 hex",       // the order's blinding factor — see ARCHITECTURE.md's security model
  "expiresAt": "9999999999"
}
```

**`201 Created`:**

```jsonc
{
  "order": { /* Order object, status OPEN or MATCHED */ },
  "match": null // or { id, buyOrderId, sellOrderId, asset, price, amount, matchedAt } if it matched immediately
}
```

**Errors:**

| Status | `error` | Cause |
|---|---|---|
| 400 | `validation_failed` | Malformed body (bad hex length, non-numeric price, etc.) — `issues` carries Zod's detail |
| 409 | `DUPLICATE` | This `id` was already submitted |
| 422 | `SIGNATURE_INVALID` | Recomputed commitment doesn't match the supplied `commitment` |
| 422 | `NOT_ON_CHAIN` | No `createOrder()` found on-chain for this `id` yet |
| 422 | `COMMITMENT_MISMATCH` | Supplied `commitment` doesn't match the one recorded on-chain |
| 422 | `NOT_OPEN_ON_CHAIN` | The on-chain order exists but isn't `OPEN` |
| 422 | `EXPIRED` | `expiresAt` is already in the past |

## `DELETE /orders/:id`

Removes the order from the Matcher's book/DB (`OPEN -> CANCELLED`) — **does not** submit an on-chain `cancelOrder()`; only the owner's wallet can do that (see ARCHITECTURE.md). `:id` is 64 lowercase hex chars.

**`200 OK`:** `{ "order": { /* status CANCELLED */ } }`

**Errors:** `400 validation_failed` (bad id), `404 NOT_FOUND`, `409 NOT_CANCELLABLE` (not currently `OPEN`).

## `GET /orders/:id`

**`200 OK`:** `{ "order": { /* Order object */ } }` — expiry is checked lazily on read (an `OPEN` order past its `expiresAt` is transitioned to `EXPIRED` on this call, not by a background job).

**Errors:** `400 validation_failed`, `404 NOT_FOUND`.

## `GET /orders/open`

**`200 OK`:** `{ "orders": [ /* Order objects, all status OPEN, oldest first */ ] }`

## `GET /orderbook`

Live snapshot of resting `OPEN` orders for one asset, aggregated by price level (one order's `amount` is added to any other resting order at the same price). This is a snapshot only — after the initial fetch, a client is expected to keep it current itself from the `order.created`/`order.cancelled`/`order.expired`/`order.matched` WS events below (each carries the full order, including `side`/`price`/`amount`), rather than repolling. There is no separate orderbook WS message type.

**Query:** `isLeft` (`"true"` or `"false"`), `left`, `right` (64 hex chars each — the `Asset` tuple).

**`200 OK`:**

```jsonc
{
  "asset": { "isLeft": true, "left": "64 hex", "right": "64 hex" },
  "bids": [{ "price": "900", "amount": "15", "orderCount": 2 }],  // highest price first
  "asks": [{ "price": "1200", "amount": "20", "orderCount": 1 }]  // lowest price first
}
```

**Errors:** `400 validation_failed` (bad/missing query params).

## `GET /trades`

Recent trades (fills) for one asset, newest first — each is a persisted `Match`. Same "fetch once, then live-update from WS" pattern as `/orderbook`: keep the tape current from `order.matched` events for that asset.

**Query:** `isLeft`, `left`, `right` (as above), `limit` (optional, default `50`, `1`-`500`).

**`200 OK`:**

```jsonc
{ "trades": [{ "id": "...", "asset": {...}, "price": "1100", "amount": "5", "matchedAt": 1700000002000 }] }
```

**Errors:** `400 validation_failed`.

## `GET /stats`

Rolling-window stats for one asset, computed on read from persisted matches — there is no separate candle/history table, so this always reflects exactly the trades within the window (default 24h) as of the request.

**Query:** `isLeft`, `left`, `right` (as above), `windowMs` (optional, default `86400000` [24h], capped at 7 days).

**`200 OK`:**

```jsonc
{
  "asset": { "isLeft": true, "left": "64 hex", "right": "64 hex" },
  "lastPrice": "1100",     // most recent trade's price in the window, or null if none
  "openPrice": "1000",     // earliest trade's price in the window, or null if none
  "high": "1100",
  "low": "1000",
  "volumeBase": "15",      // sum of `amount` (base-asset units) across the window
  "tradeCount": 2,
  "changePct": 10          // (lastPrice - openPrice) / openPrice * 100, or null if no trades / openPrice is 0
}
```

**Errors:** `400 validation_failed`.

## `GET /health`

**`200 OK`:** `{ "status": "ok", "uptimeSeconds": 123, "timestamp": "2026-07-15T12:00:00.000Z" }`

## WebSocket: `/ws`

Connect with any WebSocket client. Every message is:

```jsonc
{ "type": "order.created", "payload": { /* ... */ }, "timestamp": 1700000000000 }
```

`bigint` fields in `payload` (price/amount/expiresAt) are serialized as decimal strings, same as the REST responses.

| `type` | `payload` | Fired when |
|---|---|---|
| `order.created` | Order | A valid order is accepted (before any match attempt) |
| `order.matched` | Match | Two orders are atomically claimed as a pair |
| `order.settling` | `{ match }` | The first settlement attempt for a match begins |
| `order.filled` | `{ match, txId }` | Settlement succeeded (`txId` may be `null` if recovered from an on-chain state check rather than a fresh successful call — see MATCHER.md) |
| `order.failed` | `{ match, reason }` | Settlement permanently failed (state diverged, or retries exhausted) |
| `order.cancelled` | Order | `DELETE /orders/:id` succeeded |
| `order.expired` | Order | An order was lazily found past its `expiresAt` |

## Error body shape

Every non-2xx response is `{ "error": "<CODE>", "message": "<human-readable>" }` (validation failures additionally carry `issues`, Zod's structured detail). `404`s for unknown routes and `500`s for unhandled exceptions use the same shape (`NOT_FOUND` / `INTERNAL_ERROR`).
