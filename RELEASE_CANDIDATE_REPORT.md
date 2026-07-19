# Zekura — Release Candidate Report

**Date:** 2026-07-19
**Scope:** Full repository pass — contracts, matcher, web, deployment tooling,
CI, configuration, and documentation — performed as a final release-quality
audit ahead of external security review, open-source release, and hackathon
judging.

**Method:** Five independent audit passes, run in parallel then
cross-checked against each other and against the source directly: (1) a
full line-by-line review of both Compact contracts plus `AUDIT.md`; (2) a
dedicated matcher-backend pass covering admin auth, concurrency, commitment
verification, and the PPM reservation lifecycle; (3) a dedicated frontend
pass covering env vars, hardcoded addresses/secrets, and the client-side
admin-auth boundary; (4) a deployment/CI/docs consistency pass, including a
byte-for-byte cross-check of every deployment address against the
git-ignored `.midnight-state.json`/`.midnight-tzkr.json` source of truth;
and (5) a full run of every test suite, typecheck, lint, and production
build across all three tiers. The two highest-severity findings (contract
authorization gaps) were independently re-verified by direct source
inspection before inclusion in this report. Eight issues found during this
pass were fixed directly (see §2); everything else is reported for the
maintainer/auditor to weigh.

---

## 1. Verification results (this session, reproduced fresh)

| Check | Command | Result |
|---|---|---|
| Root contract tests | `npm run test` | **68/68 passed** (`exchange` 34, `treasury` 28, `tzkr-token` 6) |
| Root typecheck | `npm run build` (`tsc --noEmit`) | Clean, 0 errors |
| Matcher typecheck | `npm run typecheck --workspace=matcher` | Clean, 0 errors |
| Matcher lint | `npm run lint --workspace=matcher` | Clean, 0 warnings |
| Matcher tests | `npm run test --workspace=matcher` | **213/213 passed** (29 files) |
| Web typecheck | `cd web && npm run typecheck` | Clean, 0 errors |
| Web lint | `cd web && npm run lint` | Clean, 0 warnings |
| Web tests | `cd web && npm run test` | **19/19 passed** |
| Web production build | `cd web && npm run build` | Succeeds — all 21 routes (Turbopack) |
| **Total automated tests** | | **300/300 passed** |

Everything the mission asked to "run and pass" does pass. The README's own
headline number (**284**) undercounted this by 16 tests relative to its own
itemized breakdown — fixed in §2.

Not exercised in this pass (environment constraint, not a defect): a live
proof-server/indexer round trip and a real browser+wallet-extension
click-through. Both are pre-existing, explicitly disclosed gaps (see
`PRODUCTION_VALIDATION_REPORT.md` §5) and were not re-attempted here since
this session had no browser or funded wallet extension available either.

## 2. Fixes applied directly this session

Small, verifiable, non-behavioral fixes — no protocol logic, UI behavior, or
API surface changed:

| # | File | Issue | Fix |
|---|---|---|---|
| 1 | `Dockerfile.matcher` | The production Railway build baked in a **superseded** Preprod exchange address (`20f760d5…6d05c9`, the pre-asset-redesign build explicitly documented as superseded in `Deployment.md`) into the image's `.midnight-state.json`. A fresh Railway deploy of the Matcher would have pointed at a defunct contract — silently incompatible with the currently-deployed frontend and the current `f7080eee…3a949` contract. | Updated to the current address/deployer/timestamp, sourced directly from the real `.midnight-state.json`. |
| 2 | `.github/workflows/ci.yml` | `compile-contract` only ever compiled `contracts/exchange.compact`; `contract-tests`'s `npm run test` step runs `test:tzkr`, which requires `contracts/managed/tzkr-token/contract/index.js` — never compiled or uploaded. This step would fail deterministically on CI as configured. | Added a `compact compile contracts/tzkr-token.compact …` step; both compiled outputs are now uploaded/downloaded together. |
| 3 | `README.md` (4 spots) | (a) "Live Demo" table still showed the **stale** Preprod address `7d1f1f67…7eb9d1` while the "Smart Contracts" table, lower in the same file, had the current `f7080eee…3a949` — the exact class of drift the file itself warns readers about. (b) Headline "**284** automated tests" contradicted the file's own itemized math (68+213+19=**300**) and the measured count above — 2 occurrences. (c) Repository-structure tree omitted `tests/tzkr-token.test.ts` and mis-stated `treasury.test.ts` as 26 tests (actual: 28). | All four corrected in place. |
| 4 | `matcher/src/types/Order.ts`, `matcher/src/db/schema.ts`, `matcher/API.md` | All three asserted that `payoutAddress: null` makes an order "can never be filled by the PPM" — a documented eligibility gate. `PPMService.attemptFill` never actually reads `order.payoutAddress` anywhere in its body (grep-confirmed); since `settleWithProtocol` is submitted by the order owner's own wallet (not the Matcher), the real payout recipient is decided at submission time regardless of this field. The field/column/API shape are harmless to keep (no exploit — the on-chain circuit is authoritative either way), but three separate docs asserted a behavior the code doesn't have. | Corrected all three comments to state the field is stored for API-shape compatibility but not currently read as a gate; left the field itself in place (removing it would touch DB schema, API contract, and multiple test fixtures — out of proportion for a doc-accuracy fix). |
| 5 | `matcher/ARCHITECTURE.md` | DB schema diagram still showed the pre-migration `asset_is_left`/`asset_left`/`asset_right` + separate `asset_key` columns (collapsed to one `asset_key` column back in commit `2044f89`) and omitted the `payout_address` column entirely. | Redrawn to match `db/schema.ts` exactly. |
| 6 | `web/src/lib/mock/market.ts` | Comment on `TNIGHT_ASSET_ID` claimed it was NIGHT's "own all-zero unshielded token color" — it's neither all-zero (`c3` + 62 zeros) nor the real color (which is computed separately and correctly in `lib/nativeAsset.ts`). Harmless (only used for mock/display lookups, never written into `OrderDetails.asset` — confirmed via grep), but factually wrong. | Corrected to describe it as the arbitrary mock-data placeholder it actually is. |
| 7 | `matcher/src/index.ts` | `PRIVATE_STATE_PASSWORD` silently fell back to a hardcoded, source-visible placeholder password with no signal to the operator, even though `Dockerfile.matcher` sets `NODE_ENV=production` for the real Railway deploy target — exactly the "unsafe default" class this mission's security pass asked to check for. | Added a `logger.warn` when the fallback is used, so an unconfigured production deploy is loud in logs rather than silent. Left the fallback *value* and default local-devnet behavior unchanged (a hard fail risks crash-looping a deploy the operator hasn't touched this var for yet) — this is a visibility fix, not a behavior change. Re-ran matcher's full suite after: 213/213 still pass, typecheck clean. |
| 8 | `AUDIT.md` | Carried no indication that it predates and excludes the Treasury/PPM module, so its "10/10 Production Readiness Score" reads as current to anyone who opens the file in isolation (an external auditor's likely first move). | Added a scope-notice banner at the top pointing to this report's S1 finding and clarifying exactly which circuits the existing audit does and does not cover. |

## 3. Findings not fixed (flagged for maintainer / external audit)

### Security

| # | Severity | Location | Finding |
|---|---|---|---|
| S1 | **High** | `contracts/exchange.compact` — `reserveLiquidity`, `releaseLiquidity`, `releaseExpiredLiquidity` | These three circuits take **no witness and enforce no caller identity at all** — every parameter is a plain, publicly-supplied argument. This is qualitatively different from `settle()`'s "no caller check" (which is safe because a caller must supply a valid witness proving knowledge of both orders' private details). Anyone watching the mempool can see a legitimate `settleWithProtocol(orderId, quoteId, …)` about to land (the pending quote is public/enumerable) and front-run it with `releaseLiquidity(quoteId)`, flipping the reservation to `RELEASED` and making the real user's `settleWithProtocol` revert (`"Reservation is not open"`). No funds are lost or misdirected — but a persistent attacker can grief every PPM fill on the contract at trivial gas cost, defeating the fallback-liquidity feature entirely. This entire code path (the Treasury/PPM module — 8 circuits) **postdates `AUDIT.md` and was never covered by it** (confirmed: `AUDIT.md`'s authorization table lists exactly 5 circuits). Needs an explicit design decision (bind reservations to a caller identity, or accept and document the griefing risk) and inclusion in the next formal audit. |
| S2 | **Medium** | `web/src/services/midnight/ownerSecret.ts` | The DApp-local `ownerSecretKey` — the only credential that can `cancelOrder()` or approve `settleWithProtocol()` for orders created in a given browser — is a random 32 bytes generated once and stored **only** in `localStorage`, with **no export/import/backup UI anywhere in the app** (checked the Settings page specifically). Clearing site data, switching browsers, or switching devices permanently strips a user's ability to cancel their own open orders or approve a pending PPM settlement; the only recovery is waiting for `expireOrder`/`releaseExpiredLiquidity` (both permissionless, time-gated). No custodial fund loss — but a real, undocumented operational trap for real users. Not mentioned in README's "Wallet Setup" → "Troubleshooting" table. |
| S3 | **Low / centralization** | `contracts/exchange.compact` — `addAdmin` | A single admin can unilaterally add unlimited further admins instantly — no multisig, no timelock, no cap. Acceptable for a testnet Treasury; worth a mainnet-checklist item given `admins` gates real fund custody (`depositTreasury`/`withdrawTreasury`). |
| S4 | **Info** | `contracts/tzkr-token.compact` — `mint(sk, …)` | Owner secret is taken as a plain circuit parameter rather than via a `witness` function, unlike every analogous check in `exchange.compact` (`ownerSecretKey()`, `adminSecretKey()`). Functionally equivalent (still private, never disclosed) — a style inconsistency worth aligning for auditability, not a vulnerability. |
| S5 | **Medium, test-coverage gap** | `matcher/src/api/middleware/adminAuth.ts`, `POST /admin/*` routes | The signed-nonce-challenge + `MATCHER_ADMIN_ADDRESSES` allowlist scheme is well-designed on inspection (real signature verification, single-use short-TTL nonce, undifferentiated failure responses to prevent address enumeration, address bound to the signing key via `addressFromKey`) — but has **zero automated tests** (`find tests -iname '*admin*'` returns nothing). This is the one code path in the matcher that directly gates real Treasury fund movement (`/admin/treasury/deposit`, `/admin/treasury/withdraw`). Recommend tests for: wrong-key-claims-allowlisted-address rejection, expired-nonce rejection, replay-after-consumption rejection, and unauthorized-address issuance rejection, before this path is trusted with real value. |

Everything else reviewed came back clean: the `settleWithProtocol`
owner-authorization fix (`AUDIT.md` P0) is present and covered by a passing
regression test; the state machine (`OPEN → {FILLED,CANCELLED,EXPIRED}`) is
one-way and correctly gated everywhere; `settledPairs` replay protection is
sound; commitment/witness binding in `createOrder`/`cancelOrder`/`settle` is
correctly authenticating; the NIGHT payment leg math on both
`settleWithProtocol` branches is symmetric and correctly bounded (no
overflow/underflow path found); the Matcher's admin-challenge signature
scheme (`matcher/src/api/middleware/adminAuth.ts`) is a real, single-use,
expiring, undifferentiated-failure signature check exactly as documented
(though untested — S5); the PPM's on-chain liquidity-fabrication guard
(`reserveLiquidity`'s `(amount + reserved) <= balance` assert) is
authoritative regardless of what the off-chain `PricingEngine` claims, so a
local race between concurrent quotes still can't over-reserve past real
Treasury balance; `OrderService.submitOrder`'s commitment re-verification
and atomic match-claim (`db.transaction()`, no `await` inside, TOCTOU gap
closed by catching the primary-key constraint violation as ground truth)
are correctly race-free; `SettlementQueue`/`SettlementService` are
genuinely single-flight per match and re-check on-chain state before any
retry, so a lost response can't cause a double-settlement; no secrets are
ever logged anywhere in `matcher/src` (no `console.*`, no `TODO`/`FIXME`/
`debugger`); all matcher REST input is Zod-validated before reaching any
parameterized (never string-concatenated) SQL query; and the web app's
`NEXT_PUBLIC_ADMIN_ADDRESSES` is genuinely UI-only, with the real
authorization boundary server-side (nonce + wallet-signature check), exactly
as the README claims — confirmed independently by both the deployment-pass
and a dedicated frontend-focused pass, along with a clean sweep of `web/`
for hardcoded secrets/addresses, unsafe `dangerouslySetInnerHTML` usage, and
leftover debug `console.*` calls (only one found, a legitimate clipboard
fallback, not debugging residue).

### Quality / DX

| # | Severity | Finding |
|---|---|---|
| Q1 | Low | No root-level or `matcher/`-level `.env.example` — only `web/.env.example` exists. A new developer must hand-transcribe ~10 Matcher/root env vars from the README table (`MATCHER_WALLET_SEED`, `PRIVATE_STATE_PASSWORD`, `MATCHER_ADMIN_ADDRESSES`, etc.) instead of copying a template. Not fixed directly — getting placeholder guidance right (especially around the wallet-seed/password vars) is a maintainer call, not something to fabricate. |
| Q2 | Low | Root (`src/`, `scripts/`) has no lint script/config, unlike `matcher/` and `web/`. Thin surface (mostly one-shot deploy/CLI scripts) but worth closing for a "fully linted" claim. |
| Q3 | Info | Repo-wide grep for `TODO`/`FIXME`/`XXX`/`HACK` across all tracked `.ts`/`.tsx`/`.compact` returned **zero matches**. Console-logging sweep found exactly one non-`console.error` call (`web/src/components/settings/settings-page.tsx:274`), and it is a legitimate last-resort fallback (clipboard *and* `execCommand` both failed) — not leftover debugging. The "stale asset-tuple" grep (`isLeft`/`deriveAssetKey`/`Either<Bytes32,...>`) found only historical-context comments explicitly documenting what was removed, not actual dead code. This is an unusually clean codebase by these measures. |

## 4. Repository Health Score: **8/10**

Clean workspace structure, zero dead code/TODOs, passing CI-equivalent
checks across all tiers, and disclosed limitations are genuinely disclosed
rather than glossed over. Held back by a documented *pattern*, not a single
incident: this is at least the second time (per the README's own admission
of "two stale addresses live for two days undetected") that hand-maintained
address/count tables have drifted from reality — three more instances were
found and fixed this session (§2). The underlying documents are excellent;
the process that keeps them in sync with `git`/`.midnight-state.json` is not
yet automated.

## 5. Production Readiness Score: **7/10**

The protocol and application-backend layers are validated with real,
independently-verified on-chain evidence (`PRODUCTION_VALIDATION_REPORT.md`),
every automated check passes, and the one remaining gap (a literal
browser+wallet click-through) is an environment constraint, not a code
defect. Held back because this session's own findings show the deploy path
itself had not been fully verified end-to-end recently: the Railway
Dockerfile would have shipped a Matcher pointed at a dead contract (fixed in
§2), and CI's contract-test job was silently one compile step away from
failing (fixed in §2). Neither had been caught before this pass.

## 6. Security Readiness Score: **6/10**

The core privacy/authorization design is sound and independently
re-verified in this pass: commitment-binding, replay protection, the
one-way state machine, and the previously-audited P0 fix (`settleWithProtocol`
owner check) all hold up under adversarial review, and are backed by
regression tests. The score is capped at 6 because a materially-sized,
fund-adjacent code surface — the entire Treasury/PPM module (8 circuits,
holding real seeded liquidity on a public network) — **has never been
through a formal audit**, and this pass found a genuine, previously
unflagged griefing vector in it (S1). `AUDIT.md` is excellent for what it
covers; what it covers is now under half the deployed circuit surface.

## 7. Documentation Score: **7/10**

Exceptionally thorough and unusually honest for a project at this stage —
it states plainly where it hasn't been verified (§5 of
`PRODUCTION_VALIDATION_REPORT.md`) rather than overclaiming, and the
architecture/privacy-model writeups are precise enough to review a
cryptographic design from. Score held to 7, not 9, because this pass found
seven concrete, checkable inaccuracies across `README.md`,
`matcher/ARCHITECTURE.md`, `matcher/API.md`, and `AUDIT.md` (stale address,
wrong test-count headline, wrong per-suite count, an omitted file in the
repo tree, a stale DB schema diagram, an overclaimed `payoutAddress`
eligibility gate repeated in three places, and a missing scope banner on the
one file most likely to be read in isolation by an external auditor) — all
now fixed, but their presence across files this carefully written suggests
the hand-maintained sections need either
automation (generate the address table and test counts from
`.midnight-state.json` / CI output) or a pre-commit doc-lint step.

## 8. Code Quality Score: **9/10**

Zero TODO/FIXME/dead debug code across the entire tracked source tree, clean
typecheck and lint on every tier with no suppressions found, consistent
architecture (pure core / I/O-at-the-edges in the matcher, dependency
injection throughout, `app.ts` vs `index.ts` composition-root split), and
comments that consistently explain *why* rather than *what*. Not a 10 only
because of Q1/Q2 above (missing root `.env.example`, no root lint) — thin
gaps, not quality problems in the code itself.

## 9. Remaining risks

1. **S1 — PPM reservation griefing** (High). Unaudited, exploitable today
   against the live Preprod deployment at zero cost to an attacker beyond
   gas. No fund loss, but defeats the PPM's purpose if exploited
   persistently.
2. **S2 — No owner-secret backup** (Medium). Real users can lock themselves
   out of cancelling/settling their own orders by clearing browser storage,
   with no documented recovery path faster than order expiry.
3. **Unaudited Treasury/PPM surface** (structural). 8 of 13 exported
   circuits have never been through `AUDIT.md`'s process, despite moving
   real (test) NIGHT/tZKR on a public network today.
4. **S3 — Admin centralization** (Low, expected at this stage, worth
   revisiting before mainnet).
5. **S5 — No automated tests for admin-auth/Treasury-funding routes**
   (Medium). The design looks sound on inspection, but "looks sound on
   inspection" is exactly the gap a test suite exists to close, and this is
   the one matcher code path that gates real fund movement.
6. **Deploy-path drift** (mitigated, not eliminated). Eight issues were
   found and fixed in one session: three stale-artifact bugs (Dockerfile,
   CI, README ×3 spots), four doc-accuracy drift bugs (`payoutAddress`'s
   overclaimed gate repeated across 3 files, `ARCHITECTURE.md`'s stale
   schema diagram, a factually wrong mock-data comment, `AUDIT.md`'s missing
   scope banner), and one security-hardening fix (the `PRIVATE_STATE_PASSWORD`
   silent-fallback warning). All eight are fixed in this pass; the *pattern*
   — hand-maintained deployment/architecture metadata scattered across
   multiple files with no automated cross-check — is still there and will
   drift again after the next redeploy or schema change unless addressed
   structurally (see Mainnet Checklist item 7).

## 10. Remaining technical debt

- No root-level `.env.example` (Q1).
- No lint configured for `src/`/`scripts/` (Q2).
- `tzkr-token.compact`'s `mint()` uses a plain parameter instead of the
  `witness` pattern used everywhere else (S4) — cosmetic, but worth aligning
  before an external auditor asks why it's different.
- Preview network is still on the pre-Treasury 5-circuit build (disclosed
  in README as a roadmap item, not new debt, but it means Preview and
  Preprod are not equivalent testing surfaces today).
- Hand-maintained address/test-count tables in README/Deployment.md with no
  automated cross-check against `.midnight-state.json`/CI output (root
  cause of §2's findings).

## 11. Recommended Mainnet checklist

1. **Close S1** before any mainnet Treasury is funded with real value — this
   is the one finding in this report that directly undermines a stated
   product guarantee (protocol-owned liquidity as a reliable fallback).
2. **Extend `AUDIT.md`'s formal process to the Treasury/PPM module** — all 8
   circuits currently outside its scope.
3. Resolve S2 with either an export/import flow for the owner secret or a
   deterministic wallet-derived alternative, and document the interim risk
   explicitly in "Wallet Setup" → "Troubleshooting" regardless.
4. Move admin authority (`addAdmin`/`removeAdmin`/`depositTreasury`/
   `withdrawTreasury`) behind a multisig or timelock before real-value
   custody (S3).
5. Add automated tests for `matcher/src/api/middleware/adminAuth.ts` and
   the `/admin/*` routes (S5) — wrong-key, expired-nonce, replay, and
   unauthorized-address rejection cases, at minimum.
6. Perform the literal browser + funded-wallet-extension click-through that
   every session including this one has been unable to exercise
   (`PRODUCTION_VALIDATION_REPORT.md` §5) — the one item short of "complete"
   validation.
7. Automate the deployment-address/test-count tables (generate from
   `.midnight-state.json`/`.midnight-tzkr.json` and CI's own test output
   rather than hand-editing Markdown) to stop the drift pattern in §9.6 from
   recurring after the next redeploy.
8. Redeploy and re-validate Preview to parity with Preprod (already tracked
   as a README roadmap item) so both networks are equivalent audit/testing
   surfaces.

## 12. Recommended external audit scope

Priority order:

1. **`reserveLiquidity`/`releaseLiquidity`/`releaseExpiredLiquidity`
   caller-identity model (S1)** — is the current design's risk acceptable,
   and if not, what's the minimal fix that doesn't reintroduce a privacy
   leak (binding to an identity risks deanonymizing the Matcher's operator
   pattern)?
2. **Full Treasury/PPM circuit set** (`depositTreasury`, `withdrawTreasury`,
   `settleWithProtocol`, plus the three above) — arithmetic safety
   (over/underflow already spot-checked clean in this pass, but deserves
   independent confirmation), the NIGHT-payment-leg symmetry between BUY and
   SELL, and the reservation lifecycle's interaction with concurrent
   Matcher operations under real network latency (this pass reviewed the
   contract in isolation, not under live concurrent load).
3. **`tzkr-token.compact`'s `mint` authorization** and its interaction with
   `mintUnshieldedToken`'s protocol-level semantics (color determinism,
   supply-cap assumptions) — light contract, but it's the one thing standing
   between "test token" and unbounded issuance if the owner secret leaks.
4. **Matcher admin-auth challenge/signature scheme**
   (`matcher/src/api/middleware/adminAuth.ts`) — independently re-verify the
   nonce entropy, TTL, and single-use consumption under concurrent requests;
   this pass reviewed it code-side only, not under a live fuzzing/replay
   attempt, and it currently has no automated test coverage of its own (S5).
5. **Owner-secret lifecycle** (S2) — both the security model (random
   per-browser secret, never derived from a real wallet key) and the
   product risk of unrecoverable loss.
6. Standard scope: dependency audit (`npm audit` across all three
   `package-lock.json`/lockfiles — not run in this pass), and the wallet
   layer's handling of the DApp Connector API surface for a malicious or
   buggy third-party wallet extension.

## 13. Final Go / No-Go recommendation

### Public Preprod release: **GO**

Every automated check passes (300/300 tests, clean typecheck/lint on all
three tiers, clean production build), the codebase is free of dead
code/TODOs, the previously-known P0 is fixed and regression-tested, the
eight deployment-artifact and documentation-accuracy bugs found in this
session are fixed, and the project's own documentation of its limitations
is honest rather than inflated. This is a genuinely strong candidate for a
public Preprod/hackathon release as-is.

### Mainnet / real-value release: **NO-GO**, pending §11

The blocking items are narrow and well-defined, not structural: close S1
(PPM griefing) and extend the formal audit to the Treasury/PPM module before
any circuit in that module custodies real value. Nothing found in this pass
suggests a deeper redesign is needed — the core commitment/privacy
architecture is sound and has already survived one independent audit's
adversarial review.

---

*This report reflects a single-session code and configuration review. It is
not a substitute for the external audit recommended in §12, and does not
independently re-verify claims in `AUDIT.md`, `Deployment.md`, or
`PRODUCTION_VALIDATION_REPORT.md` beyond what is explicitly cross-checked
above.*
