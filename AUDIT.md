# Zekura Exchange Contract — Security Audit

**Scope:** `contracts/exchange.compact` (the sole production contract) and its
direct TypeScript integration surface (`tests/exchange.test.ts`, `src/cli.ts`,
`src/deploy.ts`, `scripts/e2e-check.ts`).
**Compiler:** `compact 0.5.1`, language version `>= 0.16`.
**Audit date:** 2026-07-15.
**Commit audited:** built on `fa3e8c9` (working tree at time of audit).

This audit treats the entire contract as in scope, not just the formally
declared "Level 1" circuits (`createOrder`/`cancelOrder`/`getOrder`) — see
[README.md](./README.md) for the Level 1 scope note. `settle()` and
`expireOrder()` were already present and are a real part of the deployed
attack surface, so they were audited and hardened to the same standard.

---

## Executive Summary

One **P0 critical authorization bypass** was found and fixed: `cancelOrder`
verified the caller's identity using `ownPublicKey()`, which Midnight's own
documentation explicitly warns is a prover-supplied witness value with no
cryptographic binding to the actual transaction signer, and must never be
used for caller verification. Concretely, any party that legitimately knows
an order's committed details — which the Matcher always does, since wallets
disclose full order details to it for settlement — could have forged
`cancelOrder` on an order it does not own. This has been fixed by replacing
the check with a witness-derived-secret identity scheme
(`deriveOwnerId(ownerSecretKey())`), matching the pattern Midnight's own
documentation and reference contracts (zk-loan, battleship, bboard,
private-party) use for exactly this purpose.

No other P0 or P1 issues were found. The existing design — commitment-based
authorization via `persistentCommit`, hash-based replay protection via
`settledPairs`, a state machine where every transition is terminal or
mutually exclusive, and strict `disclose()` discipline — is sound. Four P2/P3
items are documented below as accepted, low-severity risks with recommended
off-chain mitigations, since they either require a system-architecture change
that is explicitly out of scope for this audit, or have negligible impact.

**Verdict: production-ready for mainnet after this fix**, contingent on a
fresh deployment (see "Remaining Risks" — the fix changes `cancelOrder`'s
verifier key, so the existing Preview deployment is stale).

---

## Architecture Review

The contract implements four modules inside a single `exchange.compact`,
matching the intended "public commitment registry, confidential order book
lives with an off-chain Matcher" design. No changes were made to this
structure — module boundaries, the single-contract deployment model, and the
off-chain Matcher trust boundary are unchanged.

- **Module 1 — Order Registry** (`orders: Map<Bytes<32>, OrderRecord>`):
  `createOrder`, `getOrder`, `cancelOrder`. Each order is a commitment plus a
  4-state lifecycle enum (`OPEN → {FILLED, CANCELLED, EXPIRED}`, all terminal).
- **Module 2 — Settlement** (`settle`): atomically fills a matching buy/sell
  pair after re-verifying both parties' committed details.
- **Module 3 — Replay Protection** (`settledPairs: Set<Bytes<32>>`): a
  nullifier set, defense-in-depth alongside the state machine (see "Replay
  Protection Review").
- **Module 4 — Events** (`eventLog: Map<Bytes<32>, OrderEvent>`): append-only,
  carries only `{kind, orderId}`.

Authorization in this contract is **entirely commitment- and hash-based**,
never signature-based in the traditional sense: a party proves the right to
act on an order by proving, in zero knowledge, that it knows the private
`(OrderDetails, blinding)` pair that hashes to the order's on-chain
commitment (`verifyOrderCommitment`), and — for `cancelOrder` specifically —
that it additionally knows the secret behind the order's embedded owner
identity (`deriveOwnerId`, added by this audit). This is the correct pattern
for a privacy-preserving Compact contract per Midnight's own security
guidance; the only deviation from it (`ownPublicKey()` in `cancelOrder`) is
exactly the finding this audit fixes.

## Privacy Review

Confirmed by direct inspection and by the `Privacy: orders ledger exposes
only {commitment, state}...` regression test:

- The `orders` ledger stores only `{commitment: Bytes<32>, state: OrderState}`
  — never `asset`, `amount`, `side`, `owner`, `price`, or `expiresAt`.
- `eventLog` entries carry only `{kind, orderId}`.
- Every `disclose()` in the contract wraps only already-public circuit
  arguments (`orderId`, `commitment`, `buyOrderId`, `sellOrderId`) or values
  that are inherently safe to reveal by design (`expiresAt`, disclosed only
  to evaluate `blockTimeGte`, itself a public block-time comparison). No
  witness-sourced private field (`asset`, `amount`, `owner`, `isBuy`, `price`)
  is ever discovered inside a `disclose()` wrapper.
- The new `ownerSecretKey` witness and `deriveOwnerId` derivation follow the
  same discipline: the raw secret is never disclosed, only compared inside an
  `assert()` condition (confirmed by a clean compile with no disclosure
  errors — the Compact compiler statically rejects undeclared disclosure).
- **Commitment/blinding hygiene is a wallet responsibility, not enforceable
  by the contract.** `persistentCommit` is only hiding if the blinding factor
  is fresh and random per commitment (documented in Midnight's own writing
  guide). This contract cannot detect or prevent blinding-factor reuse across
  orders from the same wallet; it is called out here as an off-chain
  integration requirement (see "Remaining Risks", P3-2).

No new privacy leaks were introduced by this audit's fixes: `deriveOwnerId`'s
output is exactly as public as the old `ownPublicKey()`-based `owner` field
was (both are 32-byte pseudonymous identifiers stored inside the private,
never-disclosed `OrderDetails.owner` field), and it is never written to the
ledger directly — it round-trips only through the commitment.

## Threat Model

| Actor | Trusted for | Not trusted for |
|---|---|---|
| Order owner's wallet | Knows its own `OrderDetails`, blinding factor, and `ownerSecretKey`. Only party able to `cancelOrder` its own orders. | Nothing about other orders. |
| Matcher (off-chain) | Disclosed full `OrderDetails` + blinding for orders it is settling (needed to call `settle`). | **Not** trusted with any order's `ownerSecretKey` — must not be able to cancel orders it merely knows the contents of. This is exactly the boundary the P0 fix restores. |
| Any network observer | Can read all public ledger state (`orders`, `settledPairs`, `eventLog`) and submit any transaction. | Cannot forge a commitment preimage (SHA-256 binding) or a caller's `ownerSecretKey`/`orderBlinding` (never on-chain). |
| The prover (any caller's own frontend) | Controls every witness return value for its own calls, including `ownPublicKey()`. | **Must never be trusted as an authorization signal by itself** — this is the general form of the P0 finding. |

## Attack Surface

Five exported circuits, all callable by any address with no gating:
`createOrder`, `getOrder`, `cancelOrder`, `expireOrder`, `settle`. There is no
admin role, no pausability, and no privileged circuit — the entire attack
surface is "can an untrusted caller make one of these five circuits do
something it shouldn't," which is what Phases 1–4 of this audit tested
against.

---

## Security Findings

### P0 — Critical

**P0-1: `cancelOrder` authorization bypass via `ownPublicKey()`.**
`ownPublicKey()` is a witness function — its return value is supplied by the
calling party's own prover/frontend and is not cross-checked against the
transaction's actual signer (confirmed against Midnight's own
`smart-contract-security` documentation and the `zk-loan` tutorial's explicit
warning: *"An older version of this contract used `assert(ownPublicKey() ==
admin, ...)`. That pattern is bypassable ... A caller can put any 32-byte
value in that slot and the assertion will hold."*). `cancelOrder` compared
`ownPublicKey()` directly against `details.owner`, so any party able to
satisfy `verifyOrderCommitment` — i.e., any party that knows an order's
`(OrderDetails, blinding)` pair — could set their own `ownPublicKey()` return
value to `details.owner.bytes` and cancel the order, regardless of who
actually owns it.
**Failure scenario:** the Matcher, which is disclosed full order details
off-chain for every order it settles (per this contract's own trust model),
could cancel any order it is matching, at any time, without being its owner —
e.g. to grief a specific counterparty out of a fill, or to selectively cancel
orders that would settle unfavorably for the Matcher's own interests.
**Fix:** see "Fixes Applied" below.

### P1 — High

None found. (The self-trade check, P1-1 below, was already present as an
uncommitted working-tree change at the start of this audit; it is listed here
for completeness of the audit trail, not as a new finding.)

**P1-1 (pre-existing fix, verified correct): missing self-trade / wash-trade
guard in `settle`.** Without a same-owner check, a single party could match
two of its own orders against each other via `settle`, fabricating fill
volume and events with no real counterparty. A guard
(`assert(!(buyDetails.owner.bytes == sellDetails.owner.bytes), ...)`) was
already present in the working tree at audit start; this audit verified its
correctness (including against the post-fix owner-identity scheme, which
does not change its behavior since `OrderDetails.owner`'s type is unchanged)
and added the regression test `settle: rejects buy and sell orders from the
same owner`.

### P2 — Medium

**P2-1: `orderId` squatting / front-running griefing.** `createOrder` binds no
relationship between `orderId` and the (still-private) `owner` inside its
commitment — by design, since the contract cannot inspect commitment contents
at creation time without breaking privacy. If a wallet's `orderId` derivation
is predictable or observable in the mempool before its `createOrder`
transaction lands, another party can front-run it with
`createOrder(orderId, garbageCommitment)`, permanently occupying that ID
(`assert(!orders.member(id))` then blocks the legitimate order forever, since
nothing can ever cancel/settle the squatter's un-owned garbage entry either).
No funds or existing orders are at risk — this is availability griefing
against orders that have not yet been created, not a way to touch existing
state. **Not fixed in-contract**: enforcing an `orderId`-to-owner binding at
creation would require revealing part of the owner's identity in the clear
at `createOrder` time, which is an intentional privacy/architecture
trade-off outside this audit's mandate. **Recommended mitigation** (off-chain,
wallet-side): derive `orderId` unpredictably and bound to the owner, e.g.
`orderId = persistentHash(deriveOwnerId(ownerSecretKey()), freshNonce)`,
so squatting requires guessing a value no observer can derive. Documented
here for the wallet/Matcher implementation that will consume this contract.

### P3 — Low

**P3-1: `settle`/`expireOrder` place no bound on `expiresAt`.** A wallet can
commit to `expiresAt = 0` (immediately expirable) or the `Uint<64>` maximum
(never expires); the contract cannot validate this without seeing the private
`OrderDetails` at creation time. This only affects the order's own owner (an
order that expires immediately, or an order a counterparty can never force-
expire) — it is not exploitable against any other party. No fix applied;
flagged for wallet-side input validation.

**P3-2: Commitment/blinding-factor hygiene is unenforceable on-chain.**
`persistentCommit`'s hiding property depends on the blinding factor being
fresh and random per order (per Midnight's own writing guide: *"the nonce
must not be reused. If it is, you can link the commitments"*). A buggy or
malicious wallet that reuses a blinding factor across two orders with
identical `OrderDetails` would produce identical, linkable commitments. Not
fixable in-contract; documented as a wallet-implementation requirement.

**P3-3 (informational, no fix needed): `getOrder` costs a full transaction for
a public read.** `getOrder` is a ledger read wrapped in an exported circuit,
so every call still costs proof generation and a submitted transaction, even
though the same data (`{commitment, state}`) is available for free from the
indexer. This is the circuit Level 1 explicitly scopes as a deliverable, so
it was not removed; noted as a UX/cost consideration for the frontend, which
should prefer the indexer for reads and reserve `getOrder` for on-chain
composability needs only.

### Confirmed-safe (no finding, verified during this audit)

- **Integer overflow/underflow:** not applicable — the contract performs no
  arithmetic (`+`, `-`, `*`) on any `Uint<128>`/`Uint<64>` field, only
  equality/ordering comparisons. Verified against the Compact language
  reference's overflow rules; regression tests added at both types' maximum
  representable values (`settle: fills at the maximum representable Uint<128>
  price and amount`, `createOrder/settle: accepts the maximum representable
  Uint<64> expiresAt without overflow`).
- **Circuit-call atomicity:** confirmed against Midnight's transaction
  semantics documentation — a circuit call with no explicit `checkpoint()` is
  a single atomic unit; an `assert` failure anywhere in `settle` (including
  after `settledPairs.insert`) rolls back the entire call, so a failed
  settlement can never partially consume replay protection or leave orders in
  an inconsistent state. Regression test: `settle: a rejected settlement is
  fully atomic — it does not consume replay protection`.
- **TOCTOU / concurrent settlement races:** the ledger applies fallible
  contract-call segments sequentially, each against the prior segment's
  result state (not a shared pre-block snapshot), so a second `settle()` call
  racing against an already-filled order correctly observes the updated
  `FILLED` state and fails cleanly. This is ordinary sequential blockchain
  execution, not a bug in this contract.
- **Map/Set semantics:** `Map.insert`/`HashSet.insert` overwrite-on-existing-
  key (confirmed against the ledger ADT reference and the ledger's own
  `StateMap` test suite), which is why every state transition in this
  contract is guarded by an explicit `assert(record.state == OrderState.OPEN
  ...)` rather than relying on insert semantics for correctness.
- **Dead code / duplicate logic:** none found. `verifyOrderCommitment` is
  reused across `cancelOrder`, `expireOrder`, and `settle` (twice); no
  unreachable branches or redundant assertions were found in the pre-audit
  contract beyond the fixed items above.

---

## Fixes Applied

**Fix for P0-1** (`contracts/exchange.compact`):
1. Added `witness ownerSecretKey(): Bytes<32>` — reveals the caller's own
   DApp-specific secret (never a real Zswap key, never disclosed).
2. Added `export pure circuit deriveOwnerId(secretKey: Bytes<32>): Bytes<32>`
   — `persistentHash<Vector<2, Bytes<32>>>([pad(32, "zekura:owner:id"),
   secretKey])`, domain-separated per Midnight's own commitment/hash
   guidance. Exported and `pure` so wallet/off-chain code can compute the
   identical value without reimplementing the hash.
3. `cancelOrder` now asserts `details.owner.bytes ==
   deriveOwnerId(ownerSecretKey())` instead of `disclose(details.owner.bytes)
   == ownPublicKey().bytes`. `ownPublicKey()` no longer appears anywhere in
   this contract.
4. `OrderDetails.owner`'s type (`ZswapCoinPublicKey`) and the rest of the
   struct are **unchanged** — only the semantic meaning of the value a wallet
   puts in `.bytes` changes (from a raw Zswap public key to
   `deriveOwnerId(secret)`), documented inline in the struct definition.
   `settle`'s self-trade check (`buyDetails.owner.bytes ==
   sellDetails.owner.bytes`) required no code change as a result.

**Defense-in-depth added** (not a standalone finding, added alongside the
above): `settle` now asserts `buyId != sellId` up front. This path was
already unreachable (a single order cannot disclose `isBuy` as both `true`
and `false`, so the existing `isBuy`/`!isBuy` asserts already reject it), but
the explicit check makes the invariant obvious without requiring a reader to
trace through later asserts, at negligible circuit cost.

**Integration fallout fixed:** `src/cli.ts`, `src/deploy.ts`, and
`scripts/e2e-check.ts` all construct a `Witnesses<undefined>` object for the
compiled contract; each was missing the new `ownerSecretKey` witness
(required by the TypeScript type the compiler now generates) and now throws
the same explicit "not implemented — read-only" error the other two
witnesses already used, consistent with those files never actually executing
a circuit that needs it.

No other contract logic changed. External circuit signatures
(`createOrder(orderId, commitment)`, `getOrder(orderId)`,
`cancelOrder(orderId)`, `expireOrder(orderId)`,
`settle(buyOrderId, sellOrderId)`) are unchanged.

## Tests Added

All 34 tests pass (`npm run test`); 14 are new or rewritten by this audit.
Every fix above has a regression test:

- `cancelOrder: rejects a caller with the wrong ownerSecretKey`
- `cancelOrder: knowing an order's committed details/blinding is not
  sufficient to cancel it — closes the ownPublicKey() spoofing bypass` (the
  direct P0-1 regression test, simulating a Matcher-like party)
- `settle: rejects buy and sell orders from the same owner` (P1-1, adapted to
  the new owner-identity scheme)
- `settle: rejects settling an order id against itself` (new defense-in-depth
  assert)
- `settle: fills at the maximum representable Uint<128> price and amount`
- `createOrder/settle: accepts the maximum representable Uint<64> expiresAt
  without overflow`
- `settle: crosses when buy price exactly equals sell price (boundary of
  >=)`
- `createOrder/cancelOrder: round-trips correctly with an all-zero orderId,
  commitment, and blinding`
- Plus the full pre-existing suite covering `createOrder`/`getOrder`/
  `cancelOrder` positive and negative paths, the privacy invariant, and
  `settle`/`expireOrder` matching, mismatches, non-open states, commitment
  mismatches, replay, and expiry (all re-verified against the post-fix
  contract).

**Limitation:** this is a hand-rolled assertion-based suite exercising the
compiled circuits directly via `@midnight-ntwrk/compact-runtime`, not a
property-based/fuzz framework. Boundary values were chosen deliberately
(type maxima, zero bytes, equal-price crossing) rather than generated
randomly; no fuzzing harness exists in this project.

## Replay Protection Review

Two independent layers, both verified:
1. **State machine (primary):** `OPEN → FILLED` is a one-way transition; no
   circuit ever transitions an order out of `FILLED`/`CANCELLED`/`EXPIRED`.
   A replayed `settle()` on an already-filled pair fails
   `assert(buyRecord.state == OrderState.OPEN, ...)` before touching
   anything else.
2. **`settledPairs` nullifier set (defense-in-depth):** `persistentHash` of
   `[buyId, sellId]` in that positional order, inserted before the pair can
   settle again. Provably redundant with (1) under the current circuit set —
   kept anyway per this contract's own "Module 3: Replay Protection" design
   and as insurance against a possible future circuit that could re-open an
   order without going through the same state-transition path. Removing it
   would save one `Set` write per `settle()` call; not done, since Phase 2 of
   this audit's brief explicitly preserves replay protection and the storage
   cost is low relative to the security value of defense-in-depth on a
   financial settlement path.

Regression test: `settle: rejects re-settling the same order pair (replay
attack)`.

## State Machine Review

```
        createOrder
             │
             ▼
           OPEN ──cancelOrder──▶ CANCELLED
             │
             ├──expireOrder(after expiresAt)──▶ EXPIRED
             │
             └──settle(matched with a compatible order)──▶ FILLED
```

All four states other than `OPEN` are terminal — no circuit transitions out
of `FILLED`, `CANCELLED`, or `EXPIRED`. Every transition circuit
(`cancelOrder`, `expireOrder`, `settle`) asserts the current state is `OPEN`
before proceeding, so double-cancellation, double-settlement,
cancel-after-expiry, and expire-after-cancel are all rejected — each with a
dedicated regression test. No state-machine violation was found.

## Authorization Review

| Circuit | Authorization mechanism | Verdict |
|---|---|---|
| `createOrder` | None — permissionless registration of a caller-supplied commitment. Intentional: the commitment itself carries no privilege until its contents are later revealed. | Correct by design |
| `getOrder` | None — public read. | Correct by design |
| `cancelOrder` | **Fixed by this audit.** Was `ownPublicKey() == details.owner` (bypassable); now `deriveOwnerId(ownerSecretKey()) == details.owner`, a hash-commitment-based identity check the caller cannot forge without the real secret. | Fixed (was P0) |
| `expireOrder` | Time-based, not identity-based (`blockTimeGte(expiresAt)`) — callable by anyone once expired, which is correct: expiry is a public fact, not an owner privilege. | Correct by design |
| `settle` | Commitment verification (proves knowledge of both orders' true details) plus business-rule asserts (`isBuy`/`!isBuy`, asset/amount/price crossing, distinct owners). No caller-identity check, correctly — `settle` is meant to be callable by the Matcher on behalf of two other parties, not gated to either order's owner. | Correct by design |

## Remaining Risks

1. **Redeployment required.** The P0 fix changes `cancelOrder`'s circuit
   logic and therefore its verifier key. The Preview address recorded in
   `README.md` was built before this fix and no longer matches
   `contracts/exchange.compact`; it must be redeployed
   (`npm run setup -- --network preview`) before further use.
2. **P2-1 and P3-1/P3-2 above are accepted, documented risks**, not fixed
   in-contract, because closing them fully requires either an off-chain
   wallet/Matcher implementation decision (outside this repository's current
   scope — no wallet/Matcher code exists here yet) or would compromise the
   contract's privacy guarantees to enforce on-chain. They are re-listed here
   so they are not lost before that wallet/Matcher implementation exists.
3. **No live-network deployment or proof-server round trip was exercised as
   part of this audit.** Verification was performed via `compact compile`
   (clean, 5 circuits, no warnings), `tsc --noEmit` (clean), and the full
   `tests/exchange.test.ts` suite (34/34 passing) — all of which exercise the
   exact compiled circuits a real transaction would run, minus actual proof
   generation and chain submission. `npm run test:e2e` requires a deployed
   contract and running proof server/indexer and was not run as part of this
   audit; do so before mainnet as a final sanity check.
4. **No linter is configured in this project** (`package.json` has no `lint`
   script), so "no warnings" for this audit is scoped to the compiler and
   typechecker, both of which reported none.

## Production Readiness Score

**9/10** — production-ready for mainnet contingent on redeploying past the
fixed `cancelOrder` verifier key (Remaining Risk #1) and on the accepted,
documented off-chain risks above being picked up by whatever wallet/Matcher
implementation integrates with this contract. The one point held back
reflects that this audit could not exercise a live deployment/proof-server
round trip (Remaining Risk #3) — everything short of that has been reviewed,
fixed, and is covered by a passing regression suite.

---

## Verification Log

```
$ npm run compile
Compiling 5 circuits:
(exit 0, no warnings)

$ npm run build        # tsc --noEmit
(exit 0, no errors)

$ npm run test
34/34 passed
```
