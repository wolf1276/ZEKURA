# ADR-0002 v2: Adversarial Review + Revised Design — Treasury AMM as PPM Cold-Start Fallback

Status: Draft (supersedes recommendation in `0002-treasury-amm-vs-opening-auction.md`, not the problem statement)

## Part 1 — Problem validation

Traced against the real files, not the ADR's paraphrase:

- `OrderService.submitOrder` (`matcher/src/services/OrderService.ts:222-231`): no book match → calls `ppmService.attemptFill(order)`.
- `PPMService.attemptFill` (`matcher/src/ppm/PPMService.ts:107-121`): pulls `snapshot = marketDataService.getSnapshot()`, computes `referencePrice = MarketDataService.referencePrice(snapshot)`, calls `pricingEngine.quote({referencePrice, ...})`.
- `MarketDataService.referencePrice` (`matcher/src/services/MarketDataService.ts:63-69`): `lastPrice` if any trade exists, else book mid if both sides resting, else `null`. No third fallback.
- `PricingEngine.quote` (`matcher/src/ppm/PricingEngine.ts:54`): `if (request.referencePrice === null || <= 0n) return null;` — hard reject, no branch, no bootstrap path.
- `PPMService.attemptFill` line 119-121: `if (!quote) return { pending: false, reason: 'Protocol liquidity unavailable.' }` → `OrderService` treats this identically to "no match," order rests OPEN (`OrderService.ts:263`).

**No hidden bootstrap path exists.** Grepped for any second reference-price source, any seed-price constant, any admin-set-initial-price circuit — none. The ADR's problem statement is correct and the circularity argument (§3 of the original ADR) is sound: PPM's only job is to cover the no-organic-liquidity case, and its sole pricing input requires organic liquidity to already exist. This is a real structural deadlock, not a tuning problem. **Problem validation: confirmed, proceed.**

## Part 1.5 — A finding the original ADR missed entirely

This is the load-bearing issue and it invalidates §6/§7's framing of the AMM as a drop-in `PricingEngine` branch. Traced through the actual contract (`contracts/exchange.compact:124-125`):

```
export ledger treasuryBalances: Map<Bytes<32>, Uint<128>>;
export ledger treasuryReserved: Map<Bytes<32>, Uint<128>>;
```

**Treasury liquidity is one global balance per asset key, not a per-market reserve pair.** `Asset = Hex32` (`matcher/src/types/Asset.ts:22`) — a "market" is one non-NIGHT asset key, always implicitly quoted against NIGHT. Every market's SELL-side PPM fill pays out of the **same** `treasuryBalances[NIGHT_ASSET_KEY]` entry (`PPMService.ts:135`, `NIGHT_ASSET_KEY` constant in `TreasuryClient.ts:45`). There is no `treasuryBalances[market_X_NIGHT_leg]` distinct from `treasuryBalances[market_Y_NIGHT_leg]` — NIGHT is one shared pool across every market in the system.

A constant-product invariant `x·y=k` is only meaningful when `x` and `y` are *dedicated* to that one pool — draining `y` in market A must not silently starve market B's quotes. Today it would: if markets A, B, C all fall back to AMM pricing against a shared NIGHT balance, a large SELL fill in market A depletes the NIGHT that market B's AMM invariant is implicitly relying on to hold its `y` constant. The reserve ratio the ADR wants to price from (`reserveBase, reserveQuote`) isn't stable per-market state — it's a shared, contended global resource being read as if it were isolated.

This means §10 ("Migration strategy") step 1 — "add a reserve-ratio pricing function alongside referencePrice-based pricing" — is not additive in the way claimed. It requires a new ledger shape (per-market reserve pairs, or at minimum a per-market NIGHT sub-account), a new contract-level accounting model, and a new deposit/withdraw circuit surface. This is not "one more branch in `PricingEngine.quote`" (§9 of the original ADR); it's a new on-chain data model that the base asset side (`treasuryBalances[assetKey]`, already per-asset) happens to already fit, but the quote side (NIGHT) does not.

**Secondary finding**: §6 option 1 ("market creator deposits both assets... requires no protocol code changes beyond accepting a two-asset deposit") is also wrong as stated. `depositTreasury`/`withdrawTreasury` (`exchange.compact:395,413`) are called only from `api/admin.ts`, gated by `AdminAuth` verifying an allowlisted wallet (`admin.ts:14,41`). There is currently **no permissionless or creator-scoped deposit path at all** — every treasury deposit today is an admin operation. "Accepting a two-asset deposit at market-creation time" is a new circuit, a new authorization model (creator ≠ admin), and a new trust boundary, not a config change.

These two findings don't kill the AMM idea, but they mean the real scope is: (a) segregate NIGHT (or introduce virtual per-market NIGHT sub-ledgers) so one market's AMM leg can't starve another's, and (b) design a genuinely new creator-deposit authorization path. Size the work accordingly before committing to "additive, low-complexity."

## Part 2 — Attacking `quote(reserveBase, reserveQuote, tradeSize)`

Given the shared-NIGHT-pool finding above, several of these are worse than a standalone AMM would suffer:

- **Cross-market NIGHT drain (new, not in original ADR)**: an attacker sells into market A's AMM fallback repeatedly, draining the *shared* NIGHT pool. Every other market's AMM fallback (and the reference-price PPM path, which also pays SELL fills out of the same NIGHT balance — see `PPMService.ts:133-138`) goes dark simultaneously. This is a protocol-wide liquidity DoS achievable by attacking the cheapest/thinnest market, not the one you actually want to disrupt. **Critical** — this is strictly worse than the "reserve exhaustion" the ADR anticipates, because the blast radius is every market, not one.
- **Reserve-ratio manipulation via wash-style round trips**: buy then sell against the AMM leg repeatedly. Constant-product with fees returns to (approximately) the starting ratio minus fees paid to... whom? The ADR doesn't specify whether spread/fee on AMM fills accrues to treasury (making round-trips self-taxing, good) or is purely a quoting spread with the treasury absorbing inventory risk with no offsetting fee capture (bad — treasury bleeds on every round trip if inventory drifts against it before the round trip completes). This needs to be pinned down; see Part 6.
- **Sandwich on AMM leg**: since the order book has priority (hybrid design), a taker order that falls through to AMM pricing is visible (mempool/order-submission is not private here — Midnight orders are disclosed to the Matcher, `OrderService.ts:100-106`) between quote and reservation. An attacker who sees a large incoming AMM-fallback order can't easily "front-run" in the classic AMM-pool sense (there's no public mempool auction the way an EVM chain has — this is a centralized-matcher order flow), but a colluding or fast client could race a competing order into the book first to intentionally cause a match failure that forces AMM fallback at a worse price, then trade against the resulting reserve shift. Lower severity than classic MEV sandwiching but not zero.
- **Stale reserve read between quote and settlement**: correctly identified in the original ADR (§8) and correctly mitigated by binding to `expiresAt` + re-validating at settlement — **but** settlement here is asynchronous and user-wallet-submitted (`PPMService.ts:174-186`), meaning the gap between "quote computed against reserves at time T" and "settleWithProtocol executes on-chain" can be arbitrarily long up to `quoteTtlSeconds` (120s default, `PricingEngine.ts:24`). In that window, *other* reservations against the same reserves can also be created and executed. The reservation mechanism (`treasuryReserved`) correctly prevents double-spending the *reserved* amount, but it does **not** re-price: a reservation locks a **price** computed against reserves that may have moved substantially by the time it settles, especially under concurrent AMM-fallback load. A user who gets a stale-favorable quote has no incentive to not execute it even if the "fair" AMM price has since moved — this is a free option for the taker at the treasury's expense, structurally identical to a "last-look" oracle staleness attack. **High severity, not fully addressed by "bind to expiresAt."**
- **Reservation-without-settlement griefing**: `reserveLiquidity` locks liquidity into `treasuryReserved` for up to 120s with no cost to the requester if they never call `settleWithProtocol` (the reservation just expires and is later reclaimed by `releaseExpiredLiquidity`, `PPMService.ts:214-233`, itself only run on a periodic sweep). A malicious actor with many orders can chain reservations to keep a meaningful fraction of AMM-backing reserves perpetually locked-but-unsettled, capping real AMM depth for legitimate takers without ever paying for a fill. `maxExposureFraction` (20% default) limits any *one* reservation but not the sum of many concurrent unsettled ones. **Medium-High** — needs either a per-actor concurrent-reservation cap or a bond/cost for reservation.
- **Partial fills**: `settleWithProtocol` has no partial-fill support (`PricingEngine.ts:31` doc comment confirms exact-match only) — this actually *reduces* attack surface versus a typical AMM (no partial-fill price-improvement gaming), but it also means a large order against a shallow AMM leg either fully drains toward `maxExposureFraction` or is rejected outright — no graceful degradation. Combined with §5's inventory question, this pushes toward needing a trade-size cap that's tighter than `maxExposureFraction` alone provides.
- **Replay**: `quoteId` is a fresh `randomBytes(32)` per attempt (`PPMService.ts:141`) and reservations are keyed by it with an on-chain existence assert (`exchange.compact:460`) — replay is not viable as designed. No new risk from the AMM mode specifically.
- **Liquidity death spiral**: if AMM losses (stale-quote arbitrage, above) exceed fee capture, treasury inventory in a given asset trends toward zero over time, each successive quote gets wider (via `inventorySkewBps`, already implemented) but the *rate* of walk-down isn't bounded — nothing stops an asset's AMM reserve from being ground down to dust over many small individually-legal trades. Needs an explicit floor (Part 5).

## Part 3 — Treasury economics / genesis

Original ADR's §6 correctly identifies first-depositor risk but under-specifies mitigation ("minimum-reserve floor" is mentioned once in §8 with no numbers). Answering directly:

- **Can a malicious creator choose absurd ratios?** Yes, nothing in the current contract enforces a ratio bound, and (per Part 1.5) there is currently no creator-deposit path at all, so this is greenfield design, not a constraint retrofit.
- **Can they trap traders?** Yes — an absurd initial ratio posts a wildly wrong price; a trader who fills against it before arbitrage corrects it (there may be no arbitrageur watching a brand-new, illiquid market at all) is directly harmed. "Arbitrage corrects it" assumes someone is watching every new market immediately, which is not guaranteed at low volume — this is the same bootstrapping problem the ADR is trying to solve, recursively applied to price *correctness* instead of price *existence*.
- **Does arbitrage fully solve this?** No — arbitrage requires (a) someone watching, (b) sufficient counter-capital, (c) the mispricing being worth the gas/time cost. For a newly created, low-volume market this is not guaranteed, especially against a treasury pool that (per Part 1.5) may have thin, shared NIGHT backing.
- **Does the protocol need minimum liquidity?** Yes. Recommend: a minimum absolute deposit in both legs (denominated in NIGHT-equivalent value, using — carefully — the *other* markets' last organic trade price as a sanity band, not a hard oracle; if no comparable exists, a flat minimum NIGHT deposit) before a market is eligible for AMM-fallback quoting at all. Below the floor: PPM stays disabled (order rests OPEN, exactly today's behavior) rather than quoting off a laughably thin pool.
- **Maximum initial spread / genesis restriction**: recommend capping initial ratio deviation is not enforceable without an external price reference (which Midnight's "no oracle" constraint forbids per the ADR's own §7/§8). So don't try to bound the *ratio* — bound the *consequence*: cap `maxExposureFraction` much tighter (e.g. 5%, not 20%) for markets below a maturity threshold (measured in organic trade count or age), so a bad initial ratio can only be exploited a little at a time, giving arbitrage/organic flow room to correct it before major damage. This is strictly better than trying to police the ratio itself, which the "no oracle" constraint makes impossible to validate anyway.

## Part 4 — Market-making policy (missing from original ADR, designed here)

The original ADR treats this as binary (referencePrice XOR AMM). Recommend blended, continuous by market maturity, not a hard switch:

```
effectivePrice = w · referencePrice + (1 - w) · reservePrice
```

where `w` is a function of `stats.tradeCount` within the trailing window (already computed by `MarketDataService.getMarketStats`, `MarketDataService.ts` via `MatchRepository`) — e.g. `w = min(1, tradeCount / N)` for some N (20-50 trades). At `tradeCount = 0`, `w = 0`, pure AMM (today's deadlock case). As organic trades accumulate, weight shifts toward trade-derived pricing, and past N trades it's effectively 100% `referencePrice` — which already matches current (working) behavior. This removes the discontinuity the original ADR's binary branch would introduce at the exact moment `referencePrice` flips from `null` to non-null (first trade instantly and fully overriding AMM pricing is itself a jump the original design doesn't address — Part 7 of this review generalizes it). EMA/VWAP/TWAP: use a short EMA of `referencePrice` (not raw last-trade) as the "trade-derived" term once `tradeCount > 0`, to damp single-trade noise, which matters more here because early trades are by definition low-volume and easily distortive.

## Part 5 — Inventory management

`100 NIGHT → 5 NIGHT`: recommend a three-tier response, all driven off `utilizationBps`/available-balance already computed in `PricingEngine.quote` (`PricingEngine.ts:62`), extended to also gate on absolute reserve level, not just reserved/balance ratio (today's `inventorySkewBps` only reacts to *reservation* pressure, not to the *absolute balance shrinking* — a treasury that has genuinely lost 95% of an asset through fills, not reservations, sees `reserved` back near zero and utilization looking healthy even though the pool is nearly empty):

1. **Soft zone (e.g. balance 50%→20% of initial deposit)**: widen spread continuously (extend `inventorySkewBps` to also key off `1 - balance/initialDeposit`, not just utilization).
2. **Hard zone (20%→5%)**: shrink `maxExposureFraction` proportionally — smaller max trade size, not just worse price, so a single large order can't finish the drain.
3. **Floor (below 5%, or below the Part-3 minimum-liquidity threshold)**: stop AMM quoting for that asset entirely — same "return null, order rests OPEN" behavior as today's cold-start case, which is the correct convergence: an exhausted pool should degrade back to exactly the state the ADR is trying to escape, not fail open.

No automatic rebalancing recommended (would require the protocol to itself trade on the open market, introducing exactly the "protocol as market participant with information/timing advantage" concern the whole "no fabricated price" design principle exists to avoid) — rebalancing should be a deliberate, disclosed admin `depositTreasury` action, same trust model as today.

## Part 6 — Pricing invariant, re-evaluated

Agree with the original ADR's constant-product recommendation, for the reasons given (§5) — but add the finding from Part 1.5 as a hard precondition: constant-product is only sound once each market's reserve pair is actually isolated (segregated NIGHT sub-ledger or per-market virtual reserves — see below). Virtual reserves (the ADR's §5 "later optimization") should be pulled forward and treated as part of the *initial* design, not a follow-up, precisely because they're the natural mechanism to solve Part 1.5's shared-NIGHT problem: give each market a **virtual NIGHT offset** rather than a claim on a literal segregated balance, letting the constant-product formula run against `(realBase + 0, virtualNightOffset)` where actual NIGHT payouts still draw from the shared pool but the *pricing curve* per market is isolated. This turns "new ledger data model" (Part 1.5's scary finding) into "one new per-market config value (virtual offset) plus the existing shared NIGHT balance as a hard cap on total payable-out NIGHT across all markets" — smaller than a full segregated-ledger redesign, while still fixing the cross-market-drain price-manipulation vector (an attacker can still drain the *shared* NIGHT ceiling, but can no longer cheaply move *another market's price* by trading in a thin one, since each market's curve is keyed to its own virtual reserve pair). DODO-style dynamic PMM and StableSwap are correctly rejected by the original ADR (no peg assumption holds for arbitrary asset/NIGHT pairs); constant-sum is correctly rejected (insolvent under price movement).

**Recommendation: constant product with per-market virtual NIGHT reserves, backed by (and hard-capped by) the real shared NIGHT balance.**

## Part 7 — Transition, without discontinuities

Genesis (tradeCount=0) → Early (tradeCount < N, `w` ramping per Part 4) → Healthy (tradeCount ≥ N, pure trade-derived pricing, AMM fallback still available for genuine no-match gaps but no longer blended) → Mature (same as Healthy; the original ADR doesn't need a 4th distinct regime — "mature" is just "healthy with deeper book," no new pricing logic required, resist adding one). The blended-`w` formula in Part 4 is what removes the jump; the original ADR's binary branch is what would have introduced one.

## Part 8 — Security review, ranked

| Severity | Issue | Mitigation |
|---|---|---|
| Critical | Shared-NIGHT cross-market drain (Part 1.5, Part 2) | Per-market virtual reserve isolation (Part 6); hard global NIGHT payout ceiling independent of any one market's view |
| Critical | No creator/permissionless deposit path exists today (Part 1.5) — must be designed, not assumed | New authorization model, scoped narrower than full admin (deposit-only, creator-attributed, no withdraw rights) |
| High | Stale-quote free option during the up-to-120s reservation window (Part 2) | Tighten `quoteTtlSeconds` for AMM-mode quotes specifically (shorter than reference-price mode, since AMM reserves can move faster under concurrent load); consider re-validating reserve deviation at `settleWithProtocol` time and rejecting if drifted past a threshold, not just past `expiresAt` |
| Medium-High | Reservation griefing without settlement cost (Part 2) | Per-actor concurrent-reservation cap; or a small non-refundable reservation fee |
| Medium | First-depositor ratio manipulation traps early traders (Part 3) | Tight `maxExposureFraction` for immature markets; minimum-liquidity floor before AMM quoting activates |
| Medium | Unbounded inventory walk-down (Part 2, Part 5) | Absolute-balance-based tiered response (Part 5), not just utilization-based skew |
| Low | Sandwich/race via order-submission timing (Part 2) | Lower severity given no public mempool; monitor, don't over-engineer against it now |
| Low | Replay | Already mitigated by existing `quoteId`/on-chain-assert design; no new work |

## Part 9 — Implementation shape (no code)

New/changed:
- **Contract**: per-market virtual-reserve config (base+NIGHT virtual offsets) stored alongside existing `treasuryBalances`; a global NIGHT payout ceiling check inside `settleWithProtocol`'s SELL branch beyond the existing per-call `nightLiquidity.available` check (Part 8, Critical #1); a new deposit circuit scoped to market-creator attribution (Part 8, Critical #2), distinct from admin `depositTreasury`.
- **`PricingEngine.quote`**: gains the blended-`w` formula (Part 4) and a reserve-ratio pricing branch reading virtual+real reserves; `PricingConfig` gains per-market-maturity `maxExposureFraction`/`inventorySkewBps` tiers (Part 5) instead of one static config.
- **`MarketDataService`**: `getSnapshot` needs to also surface per-market virtual reserve state and maturity (`tradeCount`) for the blend weight — both already partially available (`stats.tradeCount`), needs the virtual-reserve read added.
- **New repository/table**: market-creator deposit ledger mirror (parallel to existing `TreasuryRepository` pattern) if creator deposits need off-chain accounting for UI display, same pattern already used for `treasuryHistory`.
- **Events**: extend existing `treasury.reserved`/`treasury.released` broadcast pattern with an AMM-mode flag so clients can distinguish "reference-price fill" from "AMM-fallback fill" (useful for the "instant fill but expect slippage" UX warning the original ADR's §7 table flags as a UX cost).
- **Tests**: cross-market drain scenario (two markets sharing NIGHT, verify isolation), stale-quote-drift-at-settlement rejection, reservation-griefing cap, inventory-floor convergence back to "PPM disabled" state.

Sequence for the cold-start case stays as the original ADR's diagram (§4), with the pricing engine's internal branch now blended rather than binary, and the reserve read now hitting virtual+real state rather than a single global balance.

## Part 10 — Migration

Existing markets with trade history: unaffected, `w≈1` immediately since `tradeCount` is already high — no re-pricing discontinuity. New markets: need a virtual-reserve config value at creation time (default to a conservative fixed offset if creator doesn't specify, never zero — a zero virtual offset degenerates to Part 1.5's shared-pool problem). Existing `PpmReservation`/settlement flow: genuinely unchanged (correctly identified by original ADR §10.4) since reservations don't care how the quote was derived. No downtime: this is purely new branches/tables, nothing existing changes shape.

## Part 11 — Would I deploy this with real funds?

**Not the original ADR's design as written.** The core hybrid idea (order book first, AMM as fallback only) is right, and the "no fabricated price, disclosed deposit is the price" philosophy is sound. But Part 1.5's shared-NIGHT-pool finding means the original ADR's claim of "additive, low-complexity, one more `PricingEngine` branch" understates the real scope by a wide margin — deploying the literal `quote(reserveBase, reserveQuote, tradeSize)` proposal against the current contract's single global `treasuryBalances[NIGHT]` would let any one market's AMM activity silently starve every other market's liquidity, which is a protocol-wide insolvency-adjacent risk, not a per-market tuning parameter. That must be fixed (virtual per-market reserve isolation, Part 6) before this ships. The creator-deposit path also doesn't exist yet and needs its own authorization design, not an assumed "accept a deposit" one-liner.

With those two additions (isolated per-market pricing curves backed by a hard-capped shared settlement pool, and a real creator-deposit circuit) plus the tiered inventory/maturity policy (Parts 4-5) and the tightened quote-staleness handling (Part 8), the design is sound and deployable.

## Final recommendation

Adopt the hybrid order-book-first + AMM-fallback direction from the original ADR. Do **not** adopt it as an additive `PricingEngine`-only change. Treat this as three separable pieces of work: (1) per-market virtual-reserve pricing isolation over the existing shared treasury (Part 6/9), (2) a scoped creator-deposit authorization path (Part 3/9), (3) the blended-by-maturity pricing policy replacing the binary null-check switch (Part 4/7). Ship (1) and (2) together — (1) is unsafe to deploy without (2) existing to actually seed the isolated reserves, and vice versa (2) is pointless without (1) to make deposits meaningful per-market. (3) can follow once (1)/(2) are live and generating real `tradeCount` data to blend against.
