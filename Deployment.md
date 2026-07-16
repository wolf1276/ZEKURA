# Deployment Record

Deployment history and current live status of the Zekura exchange contract
(`contracts/exchange.compact`) across every Midnight network this repo
targets. See [README.md](./README.md) for setup/usage and
[AUDIT.md](./AUDIT.md) for the security review that produced the currently
deployed contract build.

---

## Current status

| Network | Contract Address | Deployer | Deployed | Verified |
|---|---|---|---|---|
| **Preview** | `7e6fb224e13e12736fdfbaed2d80265105f3a942a88d61a494472c5e11152984` | `mn_addr_preview133whwmeuxs6zs5r0n6ad2sse6q076mk8lggq3y7pl8h4vsywp7zqgwjzmf` | 2026-07-15 | ✅ 2026-07-16 (`npm run test:e2e`, re-confirmed in the Level 4 pass below) |
| **Preprod** | `7d1f1f67c3ccb1f757a0c1a1c2ef726946db724e2f92f2e0de7c73915e7eb9d1` | `mn_addr_preprod1z2yz0lxr50t4ck74rka664fe66p8lu86uazqlnfuehx53wxkgfksezfxag` | 2026-07-16 | ✅ 2026-07-16 (`npm run test:e2e` + two independent live trade round trips, see below — this is also the frontend's default network as of the Level 4 pass) |
| Undeployed (local devnet) | not persistent — redeploy via `npm run setup` | genesis seed | — | n/a |

Both Preview and Preprod run the **same contract build** — the post-audit
`cancelOrder` owner-identity fix documented in [AUDIT.md](./AUDIT.md) (commit
`6fe3575`). `contracts/managed/exchange/` was recompiled immediately before
the Preprod deployment below and its output is byte-identical to what Preview
already runs (same source, same compiler version, `compact 0.5.1`).

`web/.env.local`'s `NEXT_PUBLIC_EXCHANGE_CONTRACT_ADDRESS_PREPROD` now points
at the Preprod address above; `NEXT_PUBLIC_EXCHANGE_CONTRACT_ADDRESS_PREVIEW`
is unchanged from its existing value. No Preview infrastructure (wallet,
deployment record, or env var) was touched by this deployment.

---

## Preprod deployment — 2026-07-16

### Pre-deployment verification

Run from a clean checkout before touching the network:

| Check | Result |
|---|---|
| `npm run compile` (`compact compile`) | ✅ 5 circuits, 0 warnings |
| `npm run build` (`tsc --noEmit`, root) | ✅ 0 errors |
| `npm run test` (root — `tests/exchange.test.ts`) | ✅ 34/34 passed |
| `matcher`: `npm run typecheck` | ✅ 0 errors |
| `matcher`: `npm run lint` | ✅ 0 errors |
| `matcher`: `npm test` (vitest) | ✅ 185/185 passed |
| `web`: `npm run typecheck` | ✅ 0 errors |
| `web`: `npm run lint` | ✅ 0 errors |
| `contracts/exchange.compact` contains the P0 owner-identity fix (`deriveOwnerId`/`ownerSecretKey`, no `ownPublicKey()`) | ✅ confirmed by direct grep against source, matches AUDIT.md |

### Deployment

1. Preprod deployer wallet (`.midnight-state.json` → `wallets.preprod`) funded
   from the Preprod faucet — confirmed **1,000,000,000 tNight** after a full
   wallet sync.
2. Local proof server started (`docker compose up -d --wait proof-server`,
   `midnightntwrk/proof-server:8.0.3`) — confirmed healthy and reachable at
   `http://127.0.0.1:6300`.
3. `npm run deploy -- --network preprod`: wallet synced, 1 NIGHT UTXO
   registered for DUST generation, DUST balance confirmed positive, contract
   deployed.
4. Result: **contract address `7d1f1f67c3ccb1f757a0c1a1c2ef726946db724e2f92f2e0de7c73915e7eb9d1`**,
   recorded in `.midnight-state.json` under `deployments.preprod`.

### Post-deployment verification

| Check | Result |
|---|---|
| `npm run test:e2e` against Preprod (`scripts/e2e-check.ts`) — reconnects via `findDeployedContract` and reads on-chain ledger state via the indexer | ✅ passed |
| `npm run test:e2e -- --network preview` (regression check — confirms Preview untouched and still independently healthy) | ✅ passed, same Preview address as before |
| `README.md` Contract Address table updated | ✅ |
| `web/.env.local` → `NEXT_PUBLIC_EXCHANGE_CONTRACT_ADDRESS_PREPROD` updated | ✅ |

### Live end-to-end trade round trip (Preprod)

Beyond the read-only smoke check, a full real trade was executed against the
live Preprod deployment to validate the entire flow, not just connectivity:

1. Started the Matcher (`matcher/`) pointed at the Preprod deployment —
   confirmed it synced its operator wallet, connected to the deployed
   contract via `findDeployedContract`, and began listening.
2. Generated a self-consistent BUY (price 1000) / SELL (price 900) order pair
   — same asset, equal amount, distinct owner identities — using the exact
   `persistentCommit`-based commitment codec the Matcher itself uses
   (`matcher/src/utils/orderDetailsCodec.ts`), so the commitments are
   cryptographically valid, not synthetic placeholders.
3. Submitted both orders' `createOrder(orderId, commitment)` calls directly
   on-chain against Preprod — both transactions confirmed (real tx IDs).
4. Submitted both orders to the live Matcher via `POST /orders`:
   - The Matcher recomputed each commitment locally and cross-checked it
     against the live indexer's on-chain record for that `orderId` — both
     accepted (`201`, `status: OPEN`).
   - The SELL submission triggered an immediate match against the resting
     BUY order (price-time-priority engine), returned in the same response.
5. `SettlementService` automatically submitted a real `settle()` transaction
   on-chain for the matched pair.
6. **Verified independently, two ways:**
   - Via the Matcher's own API (`GET /orders/:id`): both orders `FILLED`.
   - Via a direct read of the live Preprod ledger (bypassing the Matcher
     entirely — `publicDataProvider.queryContractState` +
     `Exchange.ledger(...)`, the same technique `scripts/e2e-check.ts` uses):
     both orders confirmed `state=FILLED` with the exact commitments
     submitted.
7. `GET /trades` and `GET /stats` (the endpoints the web app's Activity and
   Overview pages consume) confirmed the fill: one trade at price 900,
   volume 50, matching the settlement above.
8. Failure-path checks against the same live Matcher/Preprod state:
   - A forged (non-recomputable) commitment → `422 SIGNATURE_INVALID`.
   - A well-formed but never-registered order → `422 NOT_ON_CHAIN` (proves
     the Matcher's on-chain check is real, not trusting client input).
   - Resubmitting the already-filled BUY order → `409 DUPLICATE`.

This exercises every stage of the intended trading flow (wallet → commitment
→ Matcher verification → order book → match → settlement → ledger update)
against real Preprod infrastructure — the only step not driven through an
actual browser + wallet-extension UI, since that requires a human with a
wallet extension installed, which this verification pass could not simulate
headlessly.

**Note on wallet sync time:** the first Preprod wallet sync (resuming from a
partial checkpoint left by a previous session) took approximately 36 minutes
against the live `rpc.preprod.midnight.network` / indexer. This is expected —
`README.md` and the wallet scripts already document that public-network syncs
"may take several minutes depending on network size," and it is a one-time
cost per fresh wallet — subsequent syncs (deploy, Matcher startup, e2e-check)
resumed from the saved checkpoint in seconds to low tens of seconds.

---

## Preview deployment — 2026-07-15

Deployed prior to this session, following the P0 `cancelOrder`
owner-identity-bypass fix in [AUDIT.md](./AUDIT.md) — see that document's
"Remaining Risks" #1 for why the previous Preview address
(`c0acbedfff231c7d9ed8d8015f41881f42c5e113cbf7c9c5bc8efdcb817d8003`) was
retired. Re-verified as part of this session's Preprod work (see table
above) — still live, still independently healthy, untouched by the Preprod
deployment.

---

## Production readiness status

- **Contract:** audited (P0 fixed, see AUDIT.md), 34/34 contract tests +
  185/185 Matcher tests passing, deployed identically to both Preview and
  Preprod.
- **Live verification:** both networks pass automated on-chain smoke checks;
  Preprod additionally passed a full live trade (create → match → settle →
  ledger update), including three live failure-path checks.
- **Not yet exercised:** a real browser + wallet-extension (1AM/Lace) driven
  trade through the actual `web/` UI. Everything the UI's
  `submitCreateOrder`/network-switch code paths do has been exercised
  either by this session's live probes (same SDK calls, same providers
  pattern) or by the existing test suites — but a literal click-through has
  not been performed as part of this record.
- **Mainnet:** not in scope — no Mainnet network configuration exists in
  this repo (`src/network.ts`/`web/src/network/networkConfig.ts` both define
  only `preview`/`preprod`).

See the top-level deliverables summary (Deployment report / E2E verification
report / Remaining issues / Production readiness score) delivered alongside
this document for the full assessment.

---

## Post-deployment re-verification — 2026-07-16 (Level 2 pass)

No redeployment occurred in this pass — `git diff` against the commit that
produced the deployment above shows `contracts/exchange.compact` unchanged
except a trailing-whitespace edit inside a comment, so the live bytecode on
both networks still matches source. This entry records an independent
re-check of that claim plus a full verification run, rather than trusting
the record above at face value:

- **Live indexer query, independent of this repo's own tooling**: a direct
  GraphQL `contractAction(address: ...)` request to
  `indexer.preprod.midnight.network` for
  `7d1f1f67c3ccb1f757a0c1a1c2ef726946db724e2f92f2e0de7c73915e7eb9d1`
  returned a real `ContractCall`, confirming the address is live on-chain
  right now, not just recorded in this file.
- `npm run compile` — 5 circuits, exit 0.
- `npm run build` (root `tsc --noEmit`) — 0 errors.
- `npm run test` (root) — 34/34 passed.
- `matcher`: `npm run typecheck` — 0 errors; `npm run lint` — 0 errors;
  `npm test` — 185/185 passed.
- `web`: `npm run typecheck` — 0 errors; `npm run lint` — 0 errors;
  `npm run build` (real Next.js production build, Turbopack) — succeeded,
  all 14 routes compiled including the new privacy-proof panel on `/trade`.
- `npm run test:e2e -- --network preprod` — passed (reconnected via
  `findDeployedContract`, read live ledger state).
- `npm run test:e2e -- --network preview` — passed (Preview independently
  re-confirmed untouched and still healthy).

**Frontend change made in this pass**: the Trade page's "Privacy Status"
indicator (`market-insights.tsx`) was a static badge, not an observable
demonstration. Added `web/src/services/midnight/orderVerification.ts` (a
read-only `queryContractState` + `Exchange.ledger` lookup — the same
pattern this file already uses in `matcher/src/index.ts` and `src/cli.ts`)
and a `PrivacyProofPanel` component that, after a real order submission,
fetches that order's actual live ledger record and displays it next to the
order's real private fields, so the public/private split documented in
this repo's Privacy Model is something a user can click and observe rather
than only read about. Verified by production build (compiles cleanly into
the `/trade` route) and a headless-browser render pass (Playwright,
`/trade`/`/orders`/`/activity`/`/dashboard`, zero console errors) — the
panel's populated ("found") state was verified by code review only, not a
live screenshot, since exercising it end-to-end requires a connected
wallet extension with funds, which this automated pass cannot provide (see
"Not yet exercised" below, unchanged from the prior entry).

**Not yet exercised** (unchanged from the entry above): a real browser +
wallet-extension-driven trade through the actual `web/` UI, including a
literal wallet connect/disconnect/reconnect click-through. This remains a
human-in-the-loop step.

---

## Post-deployment re-verification — 2026-07-16, 14:41 IST (Level 3 pass)

Independent re-check performed as part of a Level 3 production-readiness
pass, a few minutes after the Level 2 entry above (same day, separate
session) — repeated here rather than assumed still valid, since "was live
earlier today" is not the same claim as "is live now":

- `npm run test:e2e -- --network preprod` — reconnected via
  `findDeployedContract` against `wss://rpc.preprod.midnight.network`, read
  live ledger state: ✅ passed, contract address unchanged
  (`7d1f1f67c3ccb1f757a0c1a1c2ef726946db724e2f92f2e0de7c73915e7eb9d1`).
- `npm run test:e2e -- --network preview` — same check against
  `wss://rpc.preview.midnight.network`: ✅ passed, contract address unchanged
  (`7e6fb224e13e12736fdfbaed2d80265105f3a942a88d61a494472c5e11152984`).
- Root (`npm run compile`, `npm run build`, `npm run test`), matcher
  (`typecheck`, `lint`, `test` — 185/185), and web (`typecheck`, `lint`,
  `test` — 19/19, `build`) all re-verified green in this same pass (see
  README.md's "Run Tests"/"Production readiness" sections for current
  counts — web gained a real test suite in this pass, previously zero).
- `web/`'s production build (`next build`) was started (`next start -p
  3100`) and driven headlessly (Playwright + system Chrome) across all six
  real routes (`/`, `/dashboard`, `/trade`, `/orders`, `/activity`,
  `/settings`) plus the new `/not-found` page, at both a 1440×900 desktop
  and a 390×844 mobile viewport: all returned the expected HTTP status,
  zero console/page errors, and zero horizontal overflow at either
  viewport.
- **Not exercised in this pass either** (same constraint as the entry
  above, unchanged): a literal wallet-extension-driven click-through. This
  automated environment has no browser extension or funded interactive
  wallet session available to it — only headless, extension-free
  navigation and direct SDK/API calls, which is what all of the checks
  above (and the Level 2 entry's live trade) actually are.

---

## Post-deployment re-verification — 2026-07-16 (Level 4 pass)

Independent re-check performed as part of a Level 4 production-readiness
pass, a separate session from the Level 2/3 entries above. No redeployment —
`contracts/exchange.compact` is unchanged since commit `fec758e` (`git diff
fec758e HEAD -- contracts/exchange.compact` is empty), and the same compiler
toolchain (`compact 0.5.1`, compiler `0.31.1`, language `0.23.0`, runtime
`0.16.0`, matching `contracts/managed/exchange/compiler/contract-info.json`)
was confirmed still installed, so the live Preprod/Preview bytecode still
matches source — this pass re-verified that claim rather than assuming it.

**CI fix (real, pre-existing bug found and fixed this pass):** the `main`
branch's most recent CI run (`bc13614`, "feat(level3): ...") had been
**failing** — `web`'s `npm run typecheck` errored on `RouteContext` (a
Next.js 15.5+/16 typed-routes global type generated into `.next/types/` by
`next build`/`next dev`, but CI runs `typecheck` *before* `build`, so a fresh
checkout has no `.next/types` yet). Fixed by changing `web/package.json`'s
`typecheck` script to `next typegen && tsc --noEmit` (`next typegen` is the
documented fix for exactly this — see
`node_modules/next/dist/docs/01-app/02-guides/upgrading/version-16.md`).
Verified locally from a clean `.next/types` removal that this resolves it;
this closes the CI/CD Level 4 requirement ("runs build, typecheck, lint, and
tests on every push and PR") for real rather than only on paper.

**Fresh full verification, this session, independent of prior sessions'
records:**

- Root: `npm run compile` (5 circuits, exit 0), `npm run build` (0 errors),
  `npm run test` (34/34).
- Matcher: `npm run typecheck` (0 errors), `npm run lint` (0 errors), `npm
  test` (185/185, 25 test files).
- Web: `npm run typecheck` (0 errors, post-fix), `npm run lint` (0 errors),
  `npm run test` (19/19), `npm run build` (production build, all 14 routes).
- Direct GraphQL query to `indexer.preprod.midnight.network` for
  `7d1f1f67c3ccb1f757a0c1a1c2ef726946db724e2f92f2e0de7c73915e7eb9d1` →
  `{"__typename":"ContractCall"}`, confirming live on-chain state right now.
- `npm run test:e2e -- --network preprod` and `-- --network preview` — both
  ✅, both addresses unchanged from the tables above.

**Frontend now defaults to Preprod, not Preview** (a Level 4 requirement:
"point the frontend to the Preprod deployment"): `DEFAULT_NETWORK_ID` in
`web/src/network/networkConfig.ts` changed from `"preview"` to `"preprod"` —
this is the one place that constant is defined, consumed by
`NetworkProvider.tsx` for both the SDK's global network id and the
pre-wallet-connect React state. Verified with a headless Chromium pass
(`next dev`, fresh browser context, no localStorage/no wallet) against
`/`, `/dashboard`, `/trade`, `/orders`, `/activity`: every route's navbar
network badge reads **"Preprod"**, zero console errors. Screenshots from
this pass are in `docs/screenshots/` and referenced from the README.

**Fresh live trade round trip on Preprod, this session** (not a rerun of the
Level 2 entry's trade — new orders, new tx ids, exercised against the
already-running live Matcher instance for this repo):

1. Generated a self-consistent BUY (price 1000) / SELL (price 900) order
   pair, same asset, equal amount (50), distinct owner identities — using
   the compiled contract's own exported `pureCircuits.deriveOwnerId` (not a
   hand-rolled reimplementation) plus the same `persistentCommit`-based
   commitment encoding `matcher/src/utils/orderDetailsCodec.ts` uses.
2. Submitted both orders' `createOrder(orderId, commitment)` directly
   on-chain against Preprod using the funded deployer wallet — both
   confirmed with real tx ids
   (`007dd999f3321d653db16979151e254ac614a84c852a8298d2c2b122213877ecd0` for
   BUY,
   `00ddf2bc367834b7c8c62a8f11955dee536b163ecbd1104548665831232f249de3` for
   SELL).
3. `POST /orders` for the BUY to the live Matcher (already running against
   this Preprod deployment) → `201`, `OPEN`, no match yet (empty order book
   confirmed via `GET /orderbook` beforehand).
4. `POST /orders` for the SELL → `201`, immediate match returned in the same
   response (price 900, amount 50, price-time-priority engine).
5. `SettlementService` automatically submitted `settle()` on-chain; polling
   `GET /orders/:id` showed both orders `FILLED` within seconds.
6. **Verified independently, bypassing the Matcher**: a direct
   `publicDataProvider.queryContractState` + `Exchange.ledger(...)` read
   against the live Preprod indexer showed both orders `state=FILLED` with
   the exact commitments submitted.
7. `GET /trades` and `GET /stats` for the traded asset both reflected the
   fill (`lastPrice: "900"`, `volumeBase: "50"`, `tradeCount: 1`) — these are
   the exact endpoints the web app's Activity/Overview pages consume.
8. Failure-path checks against the same live Matcher/Preprod state, all
   rejected correctly: resubmitting the already-filled BUY order → `409
   DUPLICATE`; a self-inconsistent forged commitment/blinding pair → `422
   SIGNATURE_INVALID`; a well-formed, self-consistent order never
   registered on-chain → `422 NOT_ON_CHAIN`.

This is a second, independent full exercise of wallet → trade → Matcher →
settlement → UI-consumed-endpoints on live Preprod infrastructure, in
addition to the Level 2 entry's trade — the same conclusion holds: every
stage passes except a literal browser + wallet-extension click-through,
which remains blocked by the lack of a wallet extension / human operator in
this automated environment (unchanged from every prior entry in this file).

**Repository prepared for public release this pass:** added `LICENSE` (MIT,
matching `package.json`'s declared license — previously missing, so GitHub
reported `licenseInfo: null` despite the repo already being public), and set
the GitHub repo topics to include `midnightntwrk` (required for Midnight
ecosystem tracking per `docs.midnight.network/blog/get-your-project-on-the-map`)
alongside `compact`, `zero-knowledge`, `privacy`, `blockchain`. Confirmed via
`git log --all --diff-filter=A` that no wallet seed, `.env`, or state file
has ever been committed to this repository's history (not just currently
gitignored).
