# Architectural blocker: tZKR cannot be custodied by Treasury — and the production fix

**Status: RESOLVED, 2026-07-19 (same day, later pass).** Section 4's redesign
below was implemented in full: `contracts/tzkr-token.compact` is now a
genuine unshielded token (`mintUnshieldedToken`), `OrderDetails.asset` is a
plain `Bytes<32>` (no more `deriveAssetKey`), and both contracts were
redeployed to Preprod (Exchange `f7080eee45c16db312e7b389dfb42963b30c7b3cd333292f689abf4e5973a949`,
tZKR `ee51fd584a48884b264adaf2fef0f5c00098084404e52cb9f5fd7e079d9c250c`,
real minted color `5698abe70f5108b2b7607846049c4bf9890f50868686823b3fc8342f230a2760`
— see Deployment.md). The Treasury was seeded with real tZKR and NIGHT, and
a live end-to-end trade (both `settle()` and `settleWithProtocol`) moved
real tZKR and NIGHT balances — confirmed by a direct on-chain read, not
just a passing transaction. The rest of this document is kept as the
historical record of the root cause and the fix that closed it.

**Originally discovered:** 2026-07-19, via direct read-only query of the live
Preprod exchange ledger (not code review alone — see "Evidence" below).
**Affected (at the time):** `contracts/tzkr-token.compact`, `contracts/exchange.compact`
(`OrderDetails.asset`, `deriveAssetKey`, every Treasury circuit), the Matcher's
asset-key handling, and every web surface that assumed tZKR moved through
Treasury the same way NIGHT does.

---

## 1. What's actually broken

The exchange contract's Treasury (`depositTreasury`, `withdrawTreasury`,
`reserveLiquidity`, `settleWithProtocol`) moves funds with Compact's
**unshielded-token primitives** — `receiveUnshielded(color, amount)` /
`sendUnshielded(color, amount, recipient)`. These operate on a single,
chain-wide namespace of "colors" (`Bytes<32>` token-type ids), each backed by
real UTXOs that a wallet or contract can hold, exactly like NIGHT itself
(NIGHT's color is the all-zero `Bytes<32>`).

tZKR (`contracts/tzkr-token.compact`) is built by composing the **OpenZeppelin
Contracts for Compact `FungibleToken` module**. That module does not use the
unshielded-color system at all — it keeps its own internal ledger,
`_balances: Map<Either<Bytes<32>, ContractAddress>, Uint128>`, private to the
tZKR contract instance. The only way to move a tZKR balance is to call the
tZKR contract's own `transfer`/`transferFrom`/`mint` circuits directly.

These are two disjoint accounting systems. The exchange contract's
`deriveAssetKey(asset)` — a `persistentHash` over an `Either` that embeds
tZKR's contract address — produces a `Bytes<32>` value that is not, and can
never become, a real unshielded color (no code anywhere calls
`mintUnshieldedToken` to mint a color matching that hash). So every Treasury
circuit that receives `deriveAssetKey(tZKR asset)` as its `assetKey` argument
is asking `receiveUnshielded`/`sendUnshielded` to move UTXOs of a token type
that has never existed and never can, via this path. It is not merely
"untested" — **it cannot succeed against a real Preprod wallet**, because
`receiveUnshielded` requires the submitting transaction to actually carry
that many real unshielded UTXOs of that exact color, and none can ever be
minted with that value.

## 2. Why this exists (root cause, not just symptom)

Straight from the vendored module's own docstring
(`contracts/lib/openzeppelin-compact-contracts/token/FungibleToken.compact`):

> "At the moment Midnight does not support contract-to-contract (C2C)
> communication ... the main circuits of this module (`transfer`,
> `transferFrom`, `_transfer`, `_mint`) reject `ContractAddress` recipients
> via an `isContract` guard, because a contract that receives tokens
> currently cannot move them back out."

Confirmed independently against Midnight's own architecture docs (queried
2026-07-19):

> "Cross-contract interaction is still under development and is not
> available for use at this time." — <https://docs.midnight.network/concepts/how-midnight-works/building-blocks>

And the language reference:

> "Compact 1.0 does not fully implement declarations of contracts and the
> cross-contract calls they support" — <https://docs.midnight.network/compact/reference/compact-reference#contract-types>

There is an accepted architecture proposal (`0010-composable-contracts-syntax.md`)
and ADR (`0007-coins-and-calls.md`) describing how inter-contract calls and
contract-to-contract coin transfers *will* work, and `midnight-js` v5.0.0
added *tooling* support for assembling/proving a transaction whose call tree
spans multiple contracts — but that tooling has nothing to call yet, because
the underlying Compact language and ledger kernel do not yet expose contract
types or inter-contract circuit calls. This is a platform roadmap item, not
something fixable inside this repository.

**Even if C2C existed today**, the OpenZeppelin `FungibleToken` module would
still reject the Exchange contract (a `ContractAddress`) as a `transfer`
recipient by design (the `isContract` guard) — because until C2C ships,
tokens sent to a contract address are permanently stranded (the contract has
no way to call back out). So two separate platform gaps stack here, not one.

## 3. Evidence (live chain, not inference)

Read-only query against the live Preprod exchange contract
`20f760d5e29cd868a2d7a25872e71cb042d8f68130e932a13e5111e5136d05c9`
(`indexerPublicDataProvider` against `indexer.preprod.midnight.network`, zero
funds spent, zero wallet needed):

```
treasuryBalances: { 0000...0000 (NIGHT): 1000 }        ← only entry, ever
treasuryReserved: { 0000...0000 (NIGHT): 0 }
treasuryHistory:  7 rows, all assetKey = NIGHT (deposit/withdraw/reserve/release)
                  zero EXECUTE rows (settleWithProtocol has never completed on this contract)
reservations:     2 open, both assetKey = NIGHT
orders:           6 real on-chain orders
```

There is no entry anywhere, for any tZKR-derived key. Every real Treasury
transaction this deployment has ever processed is NIGHT-only. This matches
the root-cause analysis exactly: the tZKR leg was never capable of
succeeding, so it never ran.

## 4. What must change — production redesign

Do not attempt a workaround (no C2C-shaped shim, no "matcher submits a
separate tZKR transfer and trusts it happened" bridge — that reintroduces
exactly the unverifiable, trust-the-client accounting the rest of this
protocol was built to avoid, since the Exchange contract would have no way
to verify a transfer that happened inside a different contract's ledger).

The correct fix, buildable today without waiting on Midnight's C2C roadmap:
**rebuild tZKR as a genuine unshielded token**, using the exact same
primitives the Treasury already correctly uses for NIGHT.

### 4.1 New tZKR contract

Replace `contracts/tzkr-token.compact`'s OpenZeppelin `FungibleToken`
composition with a minimal unshielded-token contract, following the pattern
Midnight's own tutorial documents
(<https://docs.midnight.network/tokens/unshielded-token>):

```
export ledger token_color: Bytes<32>;
export ledger initialized: Boolean;
export ledger owner: Bytes<32>;

constructor(ownerSecret: Bytes<32>) {
  owner = disclose(deriveOwnerKey(ownerSecret));
  initialized = false;
}

export circuit mint(sk: Bytes<32>, amount: Uint<64>): [] {
  assert(owner == deriveOwnerKey(sk), "not authorized to mint");
  const domain = pad(32, "zekura:tzkr:token");
  const color = mintUnshieldedToken(domain, disclose(amount), left<ContractAddress, UserAddress>(kernel.self()));
  token_color = color;
  initialized = true;
}

export circuit transfer(sk: Bytes<32>, recipient: UserAddress, amount: Uint<128>): [] {
  assert(owner == deriveOwnerKey(sk), "not authorized to transfer");
  assert(initialized, "token not minted yet");
  sendUnshielded(token_color, disclose(amount), right<ContractAddress, UserAddress>(disclose(recipient)));
}
```

This is a genuinely new contract — new address, new color, abandons the
current `b16fbbec...` deployment (which is fine: it holds no real Treasury
balance to migrate, per the evidence above).

### 4.2 Exchange contract simplification

`OrderDetails.asset` is currently `Either<Bytes<32>, Bytes<32>>` encoding a
base/quote pair, hashed via `deriveAssetKey` into an arbitrary key. Once
tZKR is a real unshielded color, this indirection is unnecessary — NIGHT is
already handled implicitly via `nativeToken()`, so every order only ever
needs to identify *one* real thing: the traded (non-NIGHT) asset's actual
color. Recommend:

- Change `OrderDetails.asset` to `Bytes<32>` directly (the real tZKR color,
  or any future token's real color).
- `deriveAssetKey` becomes unnecessary (or a trivial passthrough) — the
  asset field *is* the Treasury key and the `receiveUnshielded`/
  `sendUnshielded` token-type argument, with no hashing indirection to get
  wrong.
- This is a `settle`/`settleWithProtocol`/`createOrder` signature-relevant
  change → new verifier keys → mandatory redeploy, same class of change as
  the P0 audit fix in `AUDIT.md` and the NIGHT-payment-leg addition already
  shipped.

### 4.3 Off-chain / frontend

- `web/src/lib/mock/market.ts`: `TZKR_ASSET_ID` becomes the new contract's
  real minted color (available from `Tzkr.pureCircuits`/ledger read after
  mint), not the contract's address. Drop `TNIGHT_ASSET_ID`'s placeholder
  entirely — NIGHT is the all-zero color, already available as a constant,
  no separate "placeholder" needed.
- Wallet balance display for tZKR becomes trivial and **fully real**: read
  `wallet.state.unshielded.balances[tzkrColorHex]` the exact same way tNIGHT
  balance is already read — no bespoke tZKR balance-fetching code needed at
  all, because it is now an ordinary unshielded token like any other.
- Matcher's asset-key handling (`toOnChainAssetKey`, `TreasuryClient`,
  `PricingEngine`) needs no structural change — it already treats asset keys
  as opaque `Bytes<32>`; only the *value* changes from a synthetic hash to
  the real color.
- `src/mint-tzkr.ts`/`src/deploy-tzkr.ts` get simpler (no `Ownable`/
  `FungibleToken` witness plumbing, just the owner secret already used
  elsewhere).

### 4.4 Migration sequencing

1. Write + compile the new unshielded tZKR contract, full unit test suite
   (mirroring `tests/exchange.test.ts`'s rigor: mint authorization,
   transfer authorization, insufficient-balance rejection, color stability).
2. Update `exchange.compact`'s `OrderDetails.asset`/`deriveAssetKey`, full
   regression suite (mirroring the existing 34+ tests in
   `tests/exchange.test.ts`, extended for the simplified asset field).
3. Redeploy both contracts to Preprod (new addresses — **funding required,
   flagged separately, not before this doc is reviewed**).
4. Update the single canonical address source (`.midnight-state.json` /
   `.midnight-tzkr.json`) and every consumer of it
   (`web/.env.local`, `market.ts`, README, `Deployment.md`) in one pass —
   see the address-drift lesson recorded in `Deployment.md`'s current-status
   table, this migration is exactly the kind of change that caused that
   drift last time.
5. Scripted end-to-end validation (mirroring `scripts/e2e-check.ts`): mint
   tZKR to a seller wallet, deposit tZKR into Treasury via a real
   `depositTreasury` call, confirm `treasuryBalances` shows a real non-zero
   tZKR entry (the exact check that fails today), run a full SELL-side PPM
   fill, confirm the buyer's wallet-level unshielded tZKR balance actually
   increases.

## 5. What does work today, unblocked by this

The NIGHT-only side of Treasury/PPM (deposit, withdraw, reserve, release,
and — once a real counterpart order exists — `settleWithProtocol`'s NIGHT
leg) is architecturally sound and already has real on-chain evidence (see
"Evidence" above). This blocker is scoped **specifically** to the tZKR leg
of BUY/SELL — it does not implicate the payment-leg design, the Treasury
accounting model, the PPM reservation lifecycle, or the wallet-signature
settlement flow, all of which are correct and require no redesign.
