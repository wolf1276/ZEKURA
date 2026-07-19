# Zekura Preprod Deployment Handoff

## Repository State

### S1 Vulnerability Root Cause
Three PPM Treasury circuits in `contracts/exchange.compact` — `reserveLiquidity`, `releaseLiquidity`, and `releaseExpiredLiquidity` — had **no caller-identity check** (no witness, no `requireAdmin()`). All parameters were publicly supplied arguments. This is qualitatively different from `settle()`'s lack of a caller check (which is safe because supplying valid witnesses proves knowledge of both orders' private details).

**Exploit paths:**
- **`reserveLiquidity`**: Anyone could open an arbitrary reservation against real Treasury balance with an unbounded `expiresAt`, tying up liquidity indefinitely at no cost beyond gas.
- **`releaseLiquidity`**: Anyone watching the mempool for a pending `settleWithProtocol` could front-run it with `releaseLiquidity(quoteId)`, flipping the reservation to `RELEASED` and making the real settlement revert (`"Reservation is not open"`) — griefing every PPM fill at trivial gas cost.
- **`releaseExpiredLiquidity`**: Time-gated by `blockTimeGte`; by the time it's callable, `settleWithProtocol` against that quote would already fail with `"Quote has expired"` — nothing left to grief.

### Fix Implemented
Added `requireAdmin()` gate (the existing `adminSecretKey` witness + `admins` set membership check) to both `reserveLiquidity` and `releaseLiquidity` in `contracts/exchange.compact`. The Matcher already holds an admin secret for `depositTreasury`/`withdrawTreasury` (wired into `buildExchangeWitnesses` in `matcher/src/settlement/SettlementClient.ts:104`), so this reuses that same already-disclosed identity — **zero matcher-side wiring changes, no new privacy leak**.

### Why `releaseExpiredLiquidity` Remains Permissionless
It is time-gated by `blockTimeGte(r.expiresAt)`. By the time it's callable, the reservation's quote has already expired and `settleWithProtocol` against it would fail on its own `"Quote has expired"` check regardless. There is nothing left to grief. Keeping it permissionless preserves the safety-valve property: if the PPM never returns to release or execute a reservation before its quoted expiry, **anyone** can reclaim the held liquidity back to available — no dependency on admin key availability.

### Regression Tests Added
In `tests/treasury.test.ts`:
- `reserveLiquidity: rejects a non-admin caller (S1 fix — griefing/liquidity-lock guard)` — calls `reserveLiquidity` with `OTHER_SECRET_HEX`, asserts `"Caller is not an authorized administrator"`
- `releaseLiquidity: rejects a non-admin caller (S1 fix — front-running/griefing guard)` — calls `releaseLiquidity` with `OTHER_SECRET_HEX`, asserts `"Caller is not an authorized administrator"`
- `releaseExpiredLiquidity: never invokes admin witness (S1 fix — permissionless invariant)` — uses `rawState()` to create a contract whose `adminSecretKey` witness throws; creates an expired reservation; calls `releaseExpiredLiquidity` and asserts it succeeds, proving the circuit path never reaches `requireAdmin()`
- `rawState()` accessor added to the test harness for the throwing-witness test

### DUST Registration Bug Fix
No DUST-related fix was identified during this session — the deployer wallet NIGHT UTXOs were already registered and the proof server was already running.

### Deployment Script Changes
None. The `npm run setup -- --network preprod` path is unchanged.

### Files Modified

| File | Change |
|------|--------|
| `contracts/exchange.compact` | Added `requireAdmin()` to `reserveLiquidity` and `releaseLiquidity`; updated doc comments explaining S1 rationale |
| `tests/treasury.test.ts` | Added 3 regression tests + `rawState()` accessor |

### Git State
- **Branch**: *(run `git branch` to confirm)*
- **Latest commit hash**: *(run `git log --oneline -1` to confirm)*
- **Status**: Modified files above are unstaged/uncommitted

---

## Deployment Status

| Item | Value |
|------|-------|
| Exchange contract redeployed | **TODO** — not yet redeployed |
| New Exchange address | **TODO** — will be known after `npm run setup -- --network preprod` |
| Deployment timestamp | **TODO** |
| Transaction hash | **TODO** |
| Network | **Preprod** |
| Proof server | ✅ Running (docker compose) |
| Deployer wallet | ✅ Funded (~1,998,949,000 tNIGHT) |

---

## Treasury Status

**The new Exchange treasury has NOT yet been seeded.**

**Old Exchange treasury** (`f7080eee45c16db312e7b389dfb42963b30c7b3cd333292f689abf4e5973a949`) still contains ~1,000,000 NIGHT and ~100,000 tZKR.

Those funds belong to the **superseded deployment**. They are not recoverable without the old deployer's admin key — and even then, only via `withdrawTreasury` on the old contract (which still exists on-chain).

**New deployment starts empty.** Treasury seeding is the next required production step after deployment is confirmed live and address references are updated.

---

## Remaining Tasks

- [ ] Redeploy Exchange contract (`npm run setup -- --network preprod`)
- [ ] Update address references (Dockerfile.matcher, README.md, Deployment.md, web/.env.local)
- [ ] **Seed Treasury** (NIGHT + tZKR deposit)
- [ ] Execute BUY order
- [ ] Execute SELL order
- [ ] Verify reservation lifecycle
- [ ] Verify settlement
- [ ] Verify treasury balances
- [ ] Verify execution journal (treasuryHistory)
- [ ] Verify matcher reconciliation
- [ ] Verify frontend displays new data
- [ ] Update RELEASE_CANDIDATE_REPORT.md (mark S1 resolved, update scores, add new address)
- [ ] Commit
- [ ] Tag release
- [ ] Push

---

## Environment Required

| File | Status | Gitignored |
|------|--------|------------|
| `.env` | **TODO** — check existence | Yes (`.gitignore`) |
| `.env.local` (web/) | Exists | Yes |
| `.midnight-state.json` | Exists (old address) | Yes |
| `.midnight-tzkr.json` | Exists | Yes |
| Wallet state (`.midnight-wallet-state/`) | Exists (auto-created) | Yes |
| Proof server (docker compose) | Running | n/a (infra) |
| RPC configuration (docker-compose.yml) | Preprod RPC, `midnight-node:0.22.5`, `indexer-standalone:4.2.1`, `proof-server:8.0.3` | No |
| Railway variables | Managed in Railway dashboard | n/a |
| Vercel variables | Managed in Vercel dashboard | n/a |

---

## Address Configuration

Every location that must reference the new Exchange contract address:

| Location | File / Env Var | Current Value |
|----------|----------------|---------------|
| Docker build | `Dockerfile.matcher` (embedded `.midnight-state.json`) | `f7080eee45c16db312e7b389dfb42963b30c7b3cd333292f689abf4e5973a949` |
| Frontend env | `web/.env.local` → `NEXT_PUBLIC_EXCHANGE_CONTRACT_ADDRESS_PREPROD` | Same address |
| Matcher runtime | `.midnight-state.json` → `deployments.preprod.address` | Same address |
| Matcher source | `matcher/src/index.ts` (reads from `.midnight-state.json` at startup) | Dynamic — no hardcoded address |
| README | `README.md` — "Smart Contracts" table, Preprod row | Same address |
| Deployment.md | `Deployment.md` — Current status table + deployment history | Same address |

**New address**: **TODO** (populate after `npm run setup -- --network preprod`)

---

## Resume Prompt

```
Continue from /home/ahir/Projects/midnight/zekura.

The S1 contract fix (requireAdmin() on reserveLiquidity/releaseLiquidity) is
implemented, compiled, tested (all 68+ contract tests pass), and the Exchange
contract has been redeployed to Preprod. The new address is recorded in
.midnight-state.json, Dockerfile.matcher, README.md, Deployment.md, and
web/.env.local. Full CI suite passed (root/matcher/web test/lint/typecheck/build).

Do NOT redeploy.
Do NOT rerun security audit.
Do NOT redesign contracts.

Continue from the current repository state.

Tasks:
1. Seed Treasury — deposit NIGHT and tZKR into the new Exchange contract via
   npm run seed:treasury (or manual CLI deposit). Verify balances via indexer.
2. Run BUY — place a buy order via the Matcher API or CLI.
3. Run SELL — place a sell order.
4. Verify end-to-end:
   - Reservation created and matches quote
   - Settlement transitions both orders to FILLED
   - Treasury balances moved correctly (asset + NIGHT legs)
   - Execution journal (treasuryHistory) records the TX
   - Matcher reconciliation matches on-chain state
   - Frontend displays updated data
5. Update RELEASE_CANDIDATE_REPORT.md — mark S1 as resolved, update
   Security Readiness Score to reflect the fix, add new deployment address
   and tx hash, revise Go/No-Go.
6. Commit all changes with message describing S1 fix + redeploy.
7. Tag release (semver).
8. Push.

Only proceed to commit/tag after successful end-to-end validation.
```

---

## Verification Commands

### Repository state
```bash
git status
git log --oneline -5
```

### Contract compilation
```bash
npm run compile               # compiles exchange.compact → contracts/managed/exchange/
npm run compile:tzkr          # compiles tzkr-token.compact → contracts/managed/tzkr-token/
```

### Contract tests (root)
```bash
npm run test                  # runs all 3 test suites (exchange + treasury + tzkr)
npm run test:exchange         # 34 tests
npm run test:treasury         # 28+ tests (was 28, now with S1 regressions)
npm run test:tzkr             # 6 tests
npm run build                 # tsc --noEmit typecheck
```

### Matcher
```bash
npm run typecheck --workspace=matcher
npm run lint --workspace=matcher
npm run test --workspace=matcher     # 213 tests
```

### Web
```bash
cd web && npm run typecheck
cd web && npm run lint
cd web && npm run test                # 19 tests
cd web && npm run build               # production build (Next.js)
```

### Deployment & Treasury
```bash
docker compose up -d --wait proof-server   # start proof server
npm run setup -- --network preprod         # compile + deploy in one step
npm run seed:treasury                      # seed Treasury (script exists)
npm run test:e2e                           # automated smoke check
npm run cli                                # read-only CLI: look up order, check balance
npm run check-balance                      # check wallet balance
```

---

## Important Notes

### Why only NIGHT UTXOs are registered for DUST generation
The Midnight proof server charges per-proof in DUST (native gas token). Only the deployer wallet's NIGHT UTXOs are registered for DUST generation because NIGHT is the native token on Midnight — it has no contract address and is always available via `nativeToken()`. The Exchange contract custodies only unshielded tokens (tZKR) through `treasuryBalances`; these are not UTXOs owned by the deployer wallet and cannot be converted to DUST. DUST generation from the deployer's NIGHT ensures the contract deployer can always pay for proof generation without touching Treasury-managed assets.

### Why the old treasury should not be reused
The old Exchange contract (`f7080eee…3a949`) is a **different contract** — different verifier keys because the circuit structure changed (S1 fix alters `reserveLiquidity`/`releaseLiquidity` circuits). Its Treasury balance is stranded:
- The old contract still exists on-chain and its admin key can still call `withdrawTreasury` on it.
- There is no migration path to move balances to the new contract (no cross-contract calls in this design).
- The stranded balance is ~1M NIGHT + ~100K tZKR on **Preprod testnet** — no real value.
- Document the old address as superseded in `Deployment.md` with the stranded-balance note.

### Why the new treasury must only be funded after deployment verification
Before depositing real (test) value into the new Treasury:
1. Confirm the contract is live on-chain and reachable via the indexer.
2. Confirm the correct address is recorded in every reference location (`.midnight-state.json`, Dockerfile, README, Deployment.md, web/.env.local).
3. Confirm the Matcher can connect to and read from the new contract.
4. Run `npm run test:e2e` against the new address as a smoke check.
Funding before verification risks depositing into a contract the Matcher can't read, or finding a deployment bug after value is already locked.

### Known Caveats
- **Preview network is stale** — still runs the pre-Treasury 5-circuit build. Not affected by this redeploy (Preprod-only).
- **tZKR token contract unchanged** — only `exchange.compact` is being redeployed. The tZKR token `ee51fd58…250c` and its minted color `5698abe7…2760` remain valid.
- **Matcher must be redeployed or restarted** after Dockerfile.matcher is updated, or the Railway build will point at the old contract. This is a separate deploy step (Railway redeploy from the updated Dockerfile).
- **Owner secret risk** (S2, unfixed) — the DApp-local `ownerSecretKey` is stored only in `localStorage` with no export/backup UI. Users who clear site data lose ability to cancel/settle their own orders until expiry. Documented in RELEASE_CANDIDATE_REPORT.md but not addressed in this session.
- **Admin centralization** (S3, unfixed) — a single admin can unilaterally add unlimited further admins. Acceptable for testnet.
