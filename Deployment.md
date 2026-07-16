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
| **Preview** | `7e6fb224e13e12736fdfbaed2d80265105f3a942a88d61a494472c5e11152984` | `mn_addr_preview133whwmeuxs6zs5r0n6ad2sse6q076mk8lggq3y7pl8h4vsywp7zqgwjzmf` | 2026-07-15 | ✅ 2026-07-16 (`npm run test:e2e`) |
| **Preprod** | `7d1f1f67c3ccb1f757a0c1a1c2ef726946db724e2f92f2e0de7c73915e7eb9d1` | `mn_addr_preprod1z2yz0lxr50t4ck74rka664fe66p8lu86uazqlnfuehx53wxkgfksezfxag` | 2026-07-16 | ✅ 2026-07-16 (`npm run test:e2e` + live trade round trip, see below) |
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
