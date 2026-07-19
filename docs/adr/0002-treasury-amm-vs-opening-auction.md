# ADR-0002: Treasury-Backed AMM as PPM Fallback (vs. Opening Auction)

Status: Proposed
Supersedes: none (no prior ADR exists; PPM design intent currently lives only in code comments in `PPMService.ts`/`OrderService.ts`)

## 1. Problem statement

The PPM (Protocol/Passive Price Maker) exists to guarantee a counterparty when the order book has no match. Today it cannot quote until a `referencePrice` exists, and `referencePrice` only exists once a trade has happened or both a bid and ask are resting simultaneously:

```
Order Book → no match → PPM → needs referencePrice → referencePrice == null → cannot quote
```

`MarketDataService.referencePrice()` (`matcher/src/services/MarketDataService.ts:63-68`) returns `lastPrice` if any trade has occurred, else the book mid if both sides are resting, else `null`. `PricingEngine.quote()` (`PricingEngine.ts:53`) rejects outright when reference price is `null`. A brand-new market with a single incoming order — the exact case the PPM exists to solve — has neither a last trade nor a two-sided book, so it deadlocks by construction. The order rests OPEN and the PPM never engages until some other mechanism produces a first trade.

An opening-auction proposal was the prior candidate fix (batch-collect orders, clear at a single auction price to seed `lastPrice`). This ADR challenges that recommendation and evaluates a Treasury-backed AMM instead — pricing from treasury reserve ratios rather than from a reference price that doesn't yet exist.

## 2. Existing architecture

- **Order book**: `matcher/src/orderbook/OrderBook.ts`, in-memory, matched via `MatchingEngine.onOrderArrived`, called from `OrderService.submitOrder` (`OrderService.ts:222`).
- **PPM fallback**: `PPMService.attemptFill()` (`PPMService.ts:107-187`), invoked only when matching returns no fill (`OrderService.ts:230-231`). It quotes, reserves treasury liquidity on-chain (`TreasuryClient.reserveLiquidity`), and persists a `PpmReservation` (`OPEN`). It does not settle — settlement is submitted by the user's own wallet, since `receiveUnshielded` pulls funds from the tx submitter, and is later reconciled by `OrderService.reconcileProtocolFill()`.
- **Treasury**: no single balance field; `TreasuryRepository` mirrors on-chain `treasuryHistory`/`reservations` locally, but authoritative liquidity comes from `TreasuryClient.getLiquidity()` → `{available, balance, reserved}`.
- **Pricing**: `PricingEngine.quote(request, treasury, nowSeconds)` takes `referencePrice` from `MarketDataService`, adds `baseSpreadBps + skewBps` (skew from `reserved/balance` utilization), and checks `maxExposureFraction`.

No formal ADR exists yet for any of this; the design intent is inferred from code and comments only.

## 3. Why the reference-price model deadlocks

`referencePrice` is derived data — it requires prior trading activity to exist. The PPM's entire job is to act when there is *no* trading activity (no match). Requiring derived-from-trading data as the input to the exact mechanism meant to substitute for trading is circular. This isn't a tuning problem (spread, exposure caps) — it's a structural dependency loop. Any fix that keeps `referencePrice` as the sole pricing input (including an opening auction) is patching the symptom (empty book on day one) rather than removing the circularity (PPM depends on the thing it's supposed to provide).

## 4. Proposed architecture: Treasury-backed AMM

```
Incoming Order
      │
      ▼
 Order Book
      │
   Match?
   ├── Yes → Execute normally (unchanged)
   └── No
      ▼
 Treasury Pricing Engine (AMM)
      ▼
 Quote from reserve ratio: quote(reserveBase, reserveQuote, tradeSize)
      ▼
 Reservation + user-submitted settlement (unchanged reconciliation flow)
```

Order book keeps priority, unconditionally — this is additive to the existing "no match" branch in `OrderService.ts:224-262`, not a replacement of matching. The change is narrow: `PricingEngine.quote()` gains a second pricing mode that derives price from treasury reserve ratios instead of `referencePrice`, used only when `referencePrice === null`. When a `referencePrice` does exist (market already has trading history), keep using it — reserve-ratio pricing and trade-derived pricing aren't mutually exclusive; the AMM mode is specifically the cold-start path.

Real trades (order-book matches) continue to update `lastPrice`/stats exactly as today — untouched.

## 5. Pricing invariant options

| Invariant | Formula (illustrative) | Notes |
|---|---|---|
| Constant product (Uniswap v2 style) | `x·y = k` | Simple, well-understood, but large slippage on shallow reserves — exactly the situation at cold-start (small initial deposit). |
| Constant sum | `x + y = k` | No slippage, but insolvent under any price movement away from 1:1 — wrong for two assets with independent, moving prices. Not viable here. |
| StableSwap / Curve-style | blend of constant-sum and constant-product | Tuned for pegged/correlated assets. NIGHT/tZKR and a market's base/quote asset are not pegged in general — wrong tool unless a market is specifically a stable pair. |
| Virtual reserves (constant product with an added offset, à la Uniswap v3 concentrated liquidity or Bancor's virtual balances) | `(x+v)(y+v') = k` | Lets treasury seed a market with a *smaller* real deposit while presenting deeper effective liquidity, at the cost of a chosen (not fabricated) parameter — this is a config/policy choice about capital allocation, not a fabricated market price. |

Recommendation: constant product for the general case (matches "no oracle, no fabricated price" — the price is *entirely* a function of two real, protocol-held balances), with virtual reserves as a later capital-efficiency optimization if real cold-start deposits prove too large. Reject constant-sum and stableswap for general markets; they either misprice or require an off-invariant peg assumption this protocol doesn't have.

## 6. The reserve-seeding objection (biggest objection, addressed directly)

If price = f(reserveBase, reserveQuote), the *initial ratio* of those two reserves is itself a price decision. Options and their trust assumptions:

1. **Market creator deposits both assets.** Trust assumption: the creator picks the initial ratio, i.e., sets the opening price, same as any AMM pool creator on any chain today (Uniswap, etc.). This is transparent and on-chain — anyone can see the creator chose (say) 100:1 — and arbitrageurs/order-book trades correct it quickly if wrong, exactly as in every existing constant-product AMM. It is not a fabricated *protocol* price; it's a disclosed, attributable initial position taken by a named actor, which the order book is free to trade against and correct. This is the standard, most decentralized answer and requires no protocol code changes beyond accepting a two-asset deposit at market-creation time.
2. **Protocol treasury funds both sides.** Trust assumption: whoever controls treasury deployment picks the ratio — centralizes the cold-start price decision in the protocol operator, and consumes protocol capital for every new market. Same mechanism as (1) but with treasury as the (single, repeated) actor — better UX (no creator capital required) at the cost of concentrating price-setting authority and capital demand.
3. **Governance-approved initialization.** Trust assumption: adds a governance step before a market can open — directly conflicts with "no admin intervention after market creation" and slows cold-start, defeating the purpose of solving cold-start UX. Only justifiable if disclosed reserve ratios from options 1/2 are judged insufficient oversight.
4. **Permissionless bootstrap deposits (anyone can add to either side of a not-yet-active pool before it goes live).** Trust assumption: distributes ratio-setting across whoever shows up first — first-depositor risk (can set a favorable ratio for themselves) is a known AMM bootstrap attack, mitigated in practice by minimum-liquidity locks or bonding-curve launches. Adds real complexity (a pre-launch phase, deposit accounting, launch trigger) for a benefit (permissionlessness) that options 1/2 already get simply.

None of these fabricate a *price* in the sense the protocol currently forbids (no oracle claiming "the real-world price is X"). All of them are a real, on-chain, attributable capital position that *becomes* the price via the invariant — same category of "real" as a limit order resting in the book. Recommendation: (1), market-creator deposits both assets, as the default; it requires no new trust actor, no governance latency, and is the mechanism every comparable AMM already uses.

## 7. Comparison

| | Current PPM (reference-price) | Opening auction | Treasury AMM (no order-book priority) | Hybrid: Order book + Treasury AMM (proposed) |
|---|---|---|---|---|
| Cold-start behavior | Deadlocks (no referencePrice) | Works, but needs a batch/collection window before first price exists — delay, not instant | Works immediately from reserve ratio | Works immediately; order book still gets first shot |
| Liquidity | None until organic 2-sided book forms | Depends on auction turnout; can also fail to collect enough orders | Bounded by treasury reserves per market | Best of both: book depth + AMM floor |
| Manipulation resistance | N/A (can't quote) | Vulnerable to auction-time wash/collusion to set the clearing price | Vulnerable to reserve-draining/sandwich attacks typical of AMMs; bounded by `maxExposureFraction`-style caps | Same AMM-specific risk, but only exposed on the residual (unmatched) flow, and order-book trades correct any AMM mispricing immediately |
| Capital efficiency | N/A | High (no locked capital, but only works once) | Capital locked per-market in reserves; needs one deposit per market | Same lock cost as pure AMM, but reserves are used less often (only on no-match), so a given deposit covers more markets' worth of fallback demand over time |
| User experience | Orders can rest indefinitely with zero fill probability at launch | First trade delayed until auction clears; unclear wait time | Instant fill, but every fallback fill pays AMM slippage even when a book match would have been better priced | Instant fill only when book truly has no match; book-eligible orders get book pricing, unmatched ones get AMM — no unnecessary slippage |
| Complexity | Low (already built) | Medium (new batch/matching mode, new market-open state machine) | Medium (new pricing mode, reserve deposit/withdraw paths) | Medium — but additive to existing `attemptFill` fallback slot rather than a new state machine; reuses existing reservation/settlement plumbing |
| Compatibility with Midnight (no oracle) | Compliant by omission (can't quote) | Compliant — auction price is derived from submitted orders, not external feed | Compliant — price is a pure function of on-chain reserve balances | Compliant, same reasoning |
| Compatibility with non-custodial settlement | Compliant (no settlement path today at cold-start) | Compliant, same settlement model as today post-auction | Requires treasury to be a real settlement counterparty for AMM fills — same reservation + user-submitted-settlement pattern PPM already uses, so no new custody model | Same — reuses the existing `PpmReservation`/user-submits-settlement flow unmodified |
| Preserves "never fabricate prices" | Trivially yes (quotes nothing) | Yes — price comes from real submitted orders | Yes — price is a deterministic function of real, on-chain reserve balances | Yes, same |

## 8. Security / attack analysis

- **First-depositor / ratio-setting risk** (§6, option 4 specifically, and to a lesser extent option 1): mitigate with a minimum-reserve floor before a market accepts fallback-quoted trades, so a trivially small pool can't be trivially manipulated.
- **Sandwich/reserve-drain on the AMM leg**: standard AMM risk. Mitigate the same way `PricingEngine` already mitigates PPM exposure today — `maxExposureFraction` and per-trade size caps — applied to the AMM quote path identically.
- **Stale reserve read between quote and settlement**: since settlement is user-submitted and asynchronous (per existing PPM design), the quoted price must be tied to an `expiresAt` and re-validated against current reserves at settlement, exactly as `PpmReservation.expiresAt` already works — no new mechanism needed, same pattern extended to reserve-derived quotes.
- **No oracle means no external cross-check**: this is a design constraint (Midnight), not new risk introduced by the AMM — it applies equally to the current PPM and to the auction proposal; the invariant itself is the only "oracle," and it can only be moved by real trades or real deposits/withdrawals, both on-chain and attributable.

## 9. Trade-offs (summary)

The AMM approach trades a small amount of new pricing-mode complexity (one more branch in `PricingEngine.quote`, a reserve-ratio helper, deposit accounting on the treasury side) for removing the structural deadlock entirely and for working the instant a market is created, rather than after an auction window. The opening auction avoids touching treasury/AMM logic but only shifts the cold-start delay from "PPM can never quote" to "PPM can't quote until the auction clears" — it does not eliminate a bootstrap gap, it shortens it. The hybrid keeps the order book as the primary and cheapest price-discovery mechanism in all cases and only asks the AMM to answer when the book has nothing to say — which is exactly the scope the PPM already has today (it is a fallback, not a co-equal venue), so the hybrid is a natural extension of the existing role rather than a new subsystem.

## 10. Migration strategy from the existing PPM

1. Add a reserve-ratio pricing function alongside `referencePrice`-based pricing in `PricingEngine` — additive, `referencePrice`-based pricing keeps working unchanged when a `referencePrice` exists.
2. In `PricingEngine.quote()`, when `referencePrice === null`, use the reserve-ratio price instead of rejecting.
3. Add a two-asset deposit path at market creation (option 1, §6) for the creator to seed initial reserves; no changes to governance or admin flows.
4. Reuse `PpmReservation`, `TreasuryClient.reserveLiquidity`, and the existing user-submits-settlement + `reconcileProtocolFill` reconciliation loop unchanged — the AMM path produces the same reservation shape the rest of the system already knows how to settle and reconcile.
5. No migration is needed for markets that already have trading history — they keep using `referencePrice` as today; the new path only activates for markets currently stuck at `null`.
6. Backfill: no existing state needs to change; this is purely a new branch for a case that currently returns "cannot quote."

## 11. Recommendation

Adopt the hybrid order-book-first + Treasury AMM fallback, with constant-product pricing from creator-deposited reserves (§6 option 1) as the default seeding mechanism. This directly resolves the structural circularity in §3 (the opening auction does not), keeps every existing "no oracle / no fabricated price / non-custodial / no post-creation admin" constraint intact (§7), and is implementable as an additive branch in the existing PPM fallback path rather than a new market lifecycle/state machine (§10). The opening auction is not recommended as the fix for this specific problem — it reduces but does not remove the cold-start gap the PPM is supposed to cover, and it introduces a new batch-window state machine for that only partial benefit.
