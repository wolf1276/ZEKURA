/**
 * Level 1 test suite for the Zekura exchange contract (contracts/exchange.compact).
 *
 * Pure in-memory simulation via @midnight-ntwrk/compact-runtime — no proof
 * server, wallet, or indexer required. Exercises the compiled circuits
 * directly against a StateValue tree, exactly as the runtime would during a
 * real transaction, minus proof generation.
 *
 * Scope: createOrder / cancelOrder / getOrder and the `orders` ledger field
 * only. Matcher, Settlement, Execution, Treasury, Governance, and the SDK
 * layer are out of scope for Level 1 — see contracts/exchange.compact's
 * settle()/expireOrder() for the parts of the contract that already go
 * beyond Level 1 (kept because they were already implemented and working;
 * not exercised here).
 */
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Buffer } from 'node:buffer';
import * as rt from '@midnight-ntwrk/compact-runtime';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const contractPath = path.resolve(__dirname, '..', 'contracts', 'managed', 'exchange', 'contract', 'index.js');

// ─── OrderDetails wire encoding ─────────────────────────────────────────────
//
// createOrder() takes a pre-computed commitment and never touches the
// orderDetails/orderBlinding witnesses — so to exercise a real successful
// cancelOrder() (which recomputes persistentCommit<OrderDetails> from those
// witnesses and checks it against the stored commitment) tests need to
// compute that same commitment off-chain first, exactly as a wallet would
// before calling createOrder. This mirrors the struct layout declared in
// contracts/exchange.compact's OrderDetails, built entirely from
// @midnight-ntwrk/compact-runtime's public CompactType primitives.
type OrderDetailsValue = {
  asset: Uint8Array;
  isBuy: boolean;
  price: bigint;
  amount: bigint;
  owner: { bytes: Uint8Array };
  expiresAt: bigint;
};

const Uint128Type = new rt.CompactTypeUnsignedInteger(340282366920938463463374607431768211455n, 16);
const Uint64Type = new rt.CompactTypeUnsignedInteger(18446744073709551615n, 8);

class OrderDetailsType implements rt.CompactType<OrderDetailsValue> {
  alignment() {
    return rt.Bytes32Descriptor
      .alignment()
      .concat(
        rt.CompactTypeBoolean.alignment().concat(
          Uint128Type.alignment().concat(
            Uint128Type.alignment().concat(rt.ZswapCoinPublicKeyDescriptor.alignment().concat(Uint64Type.alignment())),
          ),
        ),
      );
  }
  fromValue(value: rt.Value): OrderDetailsValue {
    return {
      asset: rt.Bytes32Descriptor.fromValue(value),
      isBuy: rt.CompactTypeBoolean.fromValue(value),
      price: Uint128Type.fromValue(value),
      amount: Uint128Type.fromValue(value),
      owner: rt.ZswapCoinPublicKeyDescriptor.fromValue(value),
      expiresAt: Uint64Type.fromValue(value),
    };
  }
  toValue(v: OrderDetailsValue) {
    return rt.Bytes32Descriptor.toValue(v.asset)
      .concat(
        rt.CompactTypeBoolean.toValue(v.isBuy).concat(
          Uint128Type.toValue(v.price).concat(
            Uint128Type.toValue(v.amount).concat(
              rt.ZswapCoinPublicKeyDescriptor.toValue(v.owner).concat(Uint64Type.toValue(v.expiresAt)),
            ),
          ),
        ),
      );
  }
}
const orderDetailsType = new OrderDetailsType();

function computeCommitment(details: OrderDetailsValue, blinding: Uint8Array): Uint8Array {
  return rt.persistentCommit(orderDetailsType, details, blinding);
}

// ─── Test runner scaffolding ────────────────────────────────────────────────

type Result = { name: string; pass: boolean; detail?: string };
const results: Result[] = [];

function test(name: string, fn: () => void) {
  try {
    fn();
    results.push({ name, pass: true });
  } catch (e: any) {
    results.push({ name, pass: false, detail: e?.stack ?? e?.message ?? String(e) });
  }
}

function assertEq(actual: unknown, expected: unknown, msg: string) {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${expected}, got ${actual}`);
  }
}

function assertBytesEq(actual: Uint8Array, expected: Uint8Array, msg: string) {
  if (actual.length !== expected.length || !actual.every((b, i) => b === expected[i])) {
    throw new Error(`${msg}: byte mismatch`);
  }
}

function assertThrows(fn: () => void, expectedMsgSubstr: string | undefined, msg: string) {
  try {
    fn();
  } catch (e: any) {
    const errMsg = e?.message ?? String(e);
    if (expectedMsgSubstr && !errMsg.includes(expectedMsgSubstr)) {
      throw new Error(`${msg}: threw, but message "${errMsg}" did not include "${expectedMsgSubstr}"`);
    }
    return;
  }
  throw new Error(`${msg}: expected throw, none occurred`);
}

function bytes32(fill: number): Uint8Array {
  const b = new Uint8Array(32);
  b.fill(fill);
  return b;
}

const OWNER_PK_HEX = '00'.repeat(32);
const OTHER_PK_HEX = '11'.repeat(32);

// Distinct from the PK constants above: these back the ownerSecretKey
// witness, which is what cancelOrder actually authorizes against (see
// deriveOwnerId in the contract). The *_PK_HEX constants above remain only
// as realistic-looking transaction-context caller keys — cancelOrder no
// longer reads them for authorization at all.
const OWNER_SECRET_HEX = 'aa'.repeat(32);
const OTHER_SECRET_HEX = 'bb'.repeat(32);

// Bootstraps the Treasury module's required admin — irrelevant to every test
// in this file (see tests/treasury.test.ts), but the contract's constructor
// requires one regardless.
const DUMMY_ADMIN_SECRET_HEX = 'cc'.repeat(32);
const DUMMY_ADMIN_ID = new Uint8Array(32).fill(0xcc);

async function main() {
  const mod: any = await import(pathToFileURL(contractPath).href);
  const { Contract, ledger, OrderState, EventKind, pureCircuits } = mod;
  const { deriveOwnerId } = pureCircuits;

  // Fresh contract instance whose orderDetails/orderBlinding witnesses read
  // from a local, in-memory order store — standing in for the wallet's own
  // private storage. Nothing here is ever written to the ledger; it's only
  // ever read back by the circuits that need to re-verify a commitment.
  function makeContract(callerPkHex: string = OWNER_PK_HEX, ownerSecretHex: string = OWNER_SECRET_HEX) {
    const orderStore = new Map<string, { details: OrderDetailsValue; blinding: Uint8Array }>();
    const witnesses = {
      orderDetails: (context: any, orderId: Uint8Array) => {
        const key = Buffer.from(orderId).toString('hex');
        const entry = orderStore.get(key);
        if (!entry) throw new Error(`no witness data registered for order ${key}`);
        return [context.privateState, entry.details];
      },
      orderBlinding: (context: any, orderId: Uint8Array) => {
        const key = Buffer.from(orderId).toString('hex');
        const entry = orderStore.get(key);
        if (!entry) throw new Error(`no witness data registered for order ${key}`);
        return [context.privateState, entry.blinding];
      },
      // Stands in for the wallet's own DApp-specific secret (never the
      // Zswap wallet key). cancelOrder derives deriveOwnerId(this) and
      // requires it to match the order's committed owner field.
      ownerSecretKey: (context: any) => {
        return [context.privateState, Buffer.from(ownerSecretHex, 'hex')];
      },
      // Not exercised by any test in this Level 1 suite (see
      // tests/treasury.test.ts for admin/Treasury coverage) — only present
      // because Contract requires every declared witness to have an
      // implementation.
      adminSecretKey: (context: any) => {
        return [context.privateState, Buffer.from(DUMMY_ADMIN_SECRET_HEX, 'hex')];
      },
    };
    const contract = new Contract(witnesses);
    const constructorContext = rt.createConstructorContext(undefined, callerPkHex);
    const init = contract.initialState(constructorContext, DUMMY_ADMIN_ID);
    let ctx = rt.createCircuitContext(
      rt.dummyContractAddress(),
      callerPkHex,
      init.currentContractState.data,
      init.currentPrivateState,
    );

    return {
      createOrder(orderId: Uint8Array, commitment: Uint8Array) {
        const r = contract.circuits.createOrder(ctx, orderId, commitment);
        ctx = r.context;
      },
      cancelOrder(orderId: Uint8Array) {
        const r = contract.circuits.cancelOrder(ctx, orderId);
        ctx = r.context;
      },
      // getOrder was dropped as an exported circuit (block-limit reduction —
      // see contracts/exchange.compact); orders is a public ledger Map, read
      // directly instead of via a paid circuit, mirroring what the Matcher
      // itself already does (matcher/src/index.ts's onChainReader.getOrder).
      getOrder(orderId: Uint8Array) {
        const l = ledger(ctx.currentQueryContext.state);
        if (!l.orders.member(orderId)) throw new Error('Order does not exist');
        return l.orders.lookup(orderId);
      },
      // expireOrder/settle both read the current block time (via
      // blockTimeGte, backed by QueryContext.block.secondsSinceEpoch) to
      // decide expiry. atTimeSeconds, when given, rebuilds the circuit
      // context at that simulated time before calling, exactly as
      // cancelOrderAsOtherCaller rebuilds one for a different caller.
      expireOrder(orderId: Uint8Array, atTimeSeconds?: number) {
        const useCtx =
          atTimeSeconds === undefined
            ? ctx
            : rt.createCircuitContext(
                rt.dummyContractAddress(),
                callerPkHex,
                ctx.currentQueryContext.state,
                ctx.currentPrivateState,
                undefined,
                undefined,
                atTimeSeconds,
              );
        const r = contract.circuits.expireOrder(useCtx, orderId);
        ctx = r.context;
      },
      settle(buyOrderId: Uint8Array, sellOrderId: Uint8Array, atTimeSeconds?: number) {
        const useCtx =
          atTimeSeconds === undefined
            ? ctx
            : rt.createCircuitContext(
                rt.dummyContractAddress(),
                callerPkHex,
                ctx.currentQueryContext.state,
                ctx.currentPrivateState,
                undefined,
                undefined,
                atTimeSeconds,
              );
        const r = contract.circuits.settle(useCtx, buyOrderId, sellOrderId);
        ctx = r.context;
      },
      // Registers the private order payload a wallet would hold for
      // orderId, so the orderDetails/orderBlinding witnesses can serve it
      // back when a later circuit (cancelOrder) needs to reveal it.
      registerWitness(orderId: Uint8Array, details: OrderDetailsValue, blinding: Uint8Array) {
        orderStore.set(Buffer.from(orderId).toString('hex'), { details, blinding });
      },
      ledger() {
        return ledger(ctx.currentQueryContext.state);
      },
      // Raw ledger StateValue snapshot, for building an independent
      // "attacker" contract instance against the same on-chain state (see
      // attemptCancelWithForgedOwner below).
      ledgerState() {
        return ctx.currentQueryContext.state;
      },
    };
  }

  // Attempts cancelOrder from a *separate* contract/witness instance that
  // legitimately knows an order's committed (details, blinding) — exactly
  // as the Matcher would, since wallets disclose full order details to it
  // for settlement — but is wired with a different ownerSecretKey. This is
  // the regression test for the ownPublicKey()-spoofing authorization
  // bypass: before the fix, cancelOrder trusted `ownPublicKey() ==
  // details.owner`, and ownPublicKey() is a witness function any caller's
  // own frontend can report arbitrarily, so simply knowing an order's
  // details was already enough to forge ownership. Now that cancelOrder
  // instead requires deriveOwnerId(ownerSecretKey()) to match, knowing the
  // details/blinding alone must no longer be sufficient.
  function attemptCancelWithForgedOwner(opts: {
    forgedSecretHex: string;
    orderId: Uint8Array;
    details: OrderDetailsValue;
    blinding: Uint8Array;
    ledgerState: unknown;
  }) {
    const witnesses = {
      orderDetails: (context: any) => [context.privateState, opts.details],
      orderBlinding: (context: any) => [context.privateState, opts.blinding],
      ownerSecretKey: (context: any) => [context.privateState, Buffer.from(opts.forgedSecretHex, 'hex')],
      adminSecretKey: (context: any) => [context.privateState, Buffer.from(DUMMY_ADMIN_SECRET_HEX, 'hex')],
    };
    const attacker = new Contract(witnesses);
    const init = attacker.initialState(rt.createConstructorContext(undefined, OTHER_PK_HEX), DUMMY_ADMIN_ID);
    const attackerCtx = rt.createCircuitContext(
      rt.dummyContractAddress(),
      OTHER_PK_HEX,
      opts.ledgerState,
      init.currentPrivateState,
    );
    attacker.circuits.cancelOrder(attackerCtx, opts.orderId);
  }

  function sampleOrder(overrides: Partial<OrderDetailsValue> = {}): OrderDetailsValue {
    return {
      asset: bytes32(0xaa),
      isBuy: true,
      price: 1_000n,
      amount: 123_456_789n,
      owner: { bytes: deriveOwnerId(Buffer.from(OWNER_SECRET_HEX, 'hex')) },
      expiresAt: 9_999_999_999n,
      ...overrides,
    };
  }

  // ── Positive: Compile ─────────────────────────────────────────────────────
  test('Compile: compiled contract module loads with expected exports', () => {
    if (typeof Contract !== 'function') throw new Error('Contract class missing');
    if (typeof ledger !== 'function') throw new Error('ledger() reader missing');
    if (OrderState.OPEN !== 0 || OrderState.FILLED !== 1 || OrderState.CANCELLED !== 2 || OrderState.EXPIRED !== 3) {
      throw new Error('OrderState enum mismatch');
    }
  });

  // ── Positive: Deploy (simulated — initialState only, no SDK/wallet) ──────
  test('Deploy: initialState produces an empty order registry', () => {
    const c = makeContract();
    const l = c.ledger();
    assertEq(l.orders.isEmpty(), true, 'orders.isEmpty');
  });

  // ── createOrder() ──────────────────────────────────────────────────────────
  test('createOrder: stores an OPEN record with the exact commitment supplied', () => {
    const c = makeContract();
    const orderId = bytes32(0x01);
    const commitment = bytes32(0x02);
    c.createOrder(orderId, commitment);
    const l = c.ledger();
    assertEq(l.orders.member(orderId), true, 'orders.member(orderId)');
    const record = l.orders.lookup(orderId);
    assertEq(record.state, OrderState.OPEN, 'state == OPEN');
    assertBytesEq(record.commitment, commitment, 'commitment stored verbatim');
  });

  test('createOrder: rejects a duplicate orderId', () => {
    const c = makeContract();
    const orderId = bytes32(0x03);
    c.createOrder(orderId, bytes32(0x04));
    assertThrows(() => c.createOrder(orderId, bytes32(0x05)), 'Order already exists', 'duplicate orderId');
  });

  // ── getOrder() ─────────────────────────────────────────────────────────────
  test('getOrder: returns the stored commitment and state', () => {
    const c = makeContract();
    const orderId = bytes32(0x06);
    const commitment = bytes32(0x07);
    c.createOrder(orderId, commitment);
    const record = c.getOrder(orderId);
    assertEq(record.state, OrderState.OPEN, 'state');
    assertBytesEq(record.commitment, commitment, 'commitment');
  });

  test('getOrder: throws for a nonexistent orderId', () => {
    const c = makeContract();
    assertThrows(() => c.getOrder(bytes32(0x08)), 'Order does not exist', 'nonexistent orderId');
  });

  // ── cancelOrder() — success path ──────────────────────────────────────────
  test('cancelOrder: owner cancels their own open order (real commitment verification)', () => {
    const c = makeContract(OWNER_PK_HEX);
    const orderId = bytes32(0x09);
    const blinding = bytes32(0x10);
    const details = sampleOrder();
    const commitment = computeCommitment(details, blinding);

    c.createOrder(orderId, commitment);
    c.registerWitness(orderId, details, blinding);
    c.cancelOrder(orderId);

    const record = c.getOrder(orderId);
    assertEq(record.state, OrderState.CANCELLED, 'state == CANCELLED after cancel');
    assertBytesEq(record.commitment, commitment, 'commitment unchanged by cancel');
  });

  // ── cancelOrder() — negative paths ────────────────────────────────────────
  test('cancelOrder: rejects when the witnessed details do not match the stored commitment', () => {
    const c = makeContract(OWNER_PK_HEX);
    const orderId = bytes32(0x11);
    const blinding = bytes32(0x12);
    const realDetails = sampleOrder();
    const commitment = computeCommitment(realDetails, blinding);

    c.createOrder(orderId, commitment);
    // Registers different details than what the commitment was built from —
    // simulates a caller that doesn't actually know the order's true payload.
    c.registerWitness(orderId, sampleOrder({ amount: 1n }), blinding);

    assertThrows(() => c.cancelOrder(orderId), 'Order commitment mismatch', 'mismatched witness data');
  });

  test('cancelOrder: rejects a caller with the wrong ownerSecretKey', () => {
    const c = makeContract(OWNER_PK_HEX, OWNER_SECRET_HEX);
    const orderId = bytes32(0x13);
    const blinding = bytes32(0x14);
    const details = sampleOrder(); // owner == deriveOwnerId(OWNER_SECRET_HEX)
    const commitment = computeCommitment(details, blinding);

    c.createOrder(orderId, commitment);
    // Registers the correct witness data under a contract instance whose
    // ownerSecretKey is a *different* secret than the one the order's
    // owner field was derived from.
    const wrongOwnerC = makeContract(OTHER_PK_HEX, OTHER_SECRET_HEX);
    wrongOwnerC.registerWitness(orderId, details, blinding);

    assertThrows(() => wrongOwnerC.cancelOrder(orderId), 'Order does not exist', 'wrong-owner instance has no local order record');
    // The meaningful check is on the *shared* ledger: attempting the same
    // cancellation against the real ledger state, using the wrong secret,
    // must fail on ownership, not on commitment/state checks.
    assertThrows(
      () =>
        attemptCancelWithForgedOwner({
          forgedSecretHex: OTHER_SECRET_HEX,
          orderId,
          details,
          blinding,
          ledgerState: c.ledgerState(),
        }),
      'Caller is not the order owner',
      'non-owner cancel with correct commitment but wrong ownerSecretKey',
    );
    // Rejected call must not have mutated the primary ledger.
    assertEq(c.getOrder(orderId).state, OrderState.OPEN, 'status unchanged after rejected cancel');
  });

  test('cancelOrder: knowing an order\'s committed details/blinding is not sufficient to cancel it — closes the ownPublicKey() spoofing bypass', () => {
    // Simulates the Matcher: it legitimately receives full order details
    // (including the blinding factor) off-chain for settlement purposes,
    // so it can always pass verifyOrderCommitment. Before this fix,
    // cancelOrder authorized solely via `ownPublicKey() == details.owner`,
    // and ownPublicKey() is a witness function any caller's own frontend
    // can report arbitrarily — so anyone who merely knew an order's
    // details (e.g. this Matcher) could forge cancellation of orders they
    // do not own. deriveOwnerId(ownerSecretKey()) closes that hole because
    // the Matcher never learns the owner's ownerSecretKey, only the
    // order's disclosed details.
    const c = makeContract(OWNER_PK_HEX, OWNER_SECRET_HEX);
    const orderId = bytes32(0x1a);
    const blinding = bytes32(0x1b);
    const details = sampleOrder();
    const commitment = computeCommitment(details, blinding);
    c.createOrder(orderId, commitment);

    assertThrows(
      () =>
        attemptCancelWithForgedOwner({
          forgedSecretHex: OTHER_SECRET_HEX,
          orderId,
          details,
          blinding,
          ledgerState: c.ledgerState(),
        }),
      'Caller is not the order owner',
      'matcher-like party with full order details cannot cancel',
    );
    assertEq(c.getOrder(orderId).state, OrderState.OPEN, 'order remains OPEN — not cancellable by a non-owner who merely knows its details');
  });

  test('cancelOrder: rejects cancelling an already-cancelled order', () => {
    const c = makeContract(OWNER_PK_HEX);
    const orderId = bytes32(0x15);
    const blinding = bytes32(0x16);
    const details = sampleOrder();
    const commitment = computeCommitment(details, blinding);

    c.createOrder(orderId, commitment);
    c.registerWitness(orderId, details, blinding);
    c.cancelOrder(orderId);

    assertThrows(() => c.cancelOrder(orderId), 'Order is not open', 'double cancel');
  });

  test('cancelOrder: rejects a nonexistent orderId', () => {
    const c = makeContract();
    assertThrows(() => c.cancelOrder(bytes32(0x17)), 'Order does not exist', 'cancel missing id');
  });

  // ── Privacy: private witness data never becomes public ledger state ──────
  test('Privacy: orders ledger exposes only {commitment, state}, never the private order payload', () => {
    const c = makeContract(OWNER_PK_HEX);
    const orderId = bytes32(0x18);
    const blinding = bytes32(0x19);
    // Distinctive, otherwise-implausible private values, so a leak would be
    // unambiguous rather than coincidentally matching some other field.
    const details = sampleOrder({ amount: 987_654_321n, price: 42_424_242n });
    const commitment = computeCommitment(details, blinding);

    c.createOrder(orderId, commitment);
    c.registerWitness(orderId, details, blinding);
    c.cancelOrder(orderId); // exercises the circuit that actually reads the private witnesses

    const l = c.ledger();

    // The ledger type itself must expose no field capable of carrying order
    // details — order-related state is only ever orders/settledPairs/
    // eventLog (the Treasury fields alongside them carry no order data
    // either — see tests/treasury.test.ts), matching the "public ledger
    // stores ONLY orderId, commitment, state" architecture rule.
    assertEq(
      JSON.stringify(Object.keys(l).sort()),
      JSON.stringify([
        'admins',
        'eventLog',
        'orders',
        'reservations',
        'settledPairs',
        'treasuryBalances',
        'treasuryHistory',
        'treasuryHistorySeq',
        'treasuryReserved',
      ]),
      'ledger top-level fields',
    );

    // Every record in `orders`, including the one just cancelled, must have
    // exactly two fields — commitment and state — never asset/amount/price/
    // owner/side/expiresAt.
    for (const [, record] of l.orders) {
      assertEq(JSON.stringify(Object.keys(record).sort()), JSON.stringify(['commitment', 'state']), 'order record fields');
      assertEq((record as any).amount, undefined, 'amount is not a ledger field');
      assertEq((record as any).price, undefined, 'price is not a ledger field');
      assertEq((record as any).owner, undefined, 'owner is not a ledger field');
      assertEq((record as any).asset, undefined, 'asset is not a ledger field');
      assertEq((record as any).isBuy, undefined, 'isBuy is not a ledger field');
      assertEq((record as any).expiresAt, undefined, 'expiresAt is not a ledger field');
    }

    // eventLog entries are the same story: {kind, orderId} only.
    for (const [, event] of l.eventLog) {
      assertEq(JSON.stringify(Object.keys(event).sort()), JSON.stringify(['kind', 'orderId']), 'event fields');
    }
  });

  // ── Settlement helpers ────────────────────────────────────────────────────
  function sampleBuyOrder(overrides: Partial<OrderDetailsValue> = {}): OrderDetailsValue {
    return sampleOrder({
      isBuy: true,
      price: 1_200n,
      owner: { bytes: deriveOwnerId(Buffer.from(OWNER_SECRET_HEX, 'hex')) },
      ...overrides,
    });
  }

  function sampleSellOrder(overrides: Partial<OrderDetailsValue> = {}): OrderDetailsValue {
    return sampleOrder({
      isBuy: false,
      price: 1_000n,
      owner: { bytes: deriveOwnerId(Buffer.from(OTHER_SECRET_HEX, 'hex')) },
      ...overrides,
    });
  }

  // Sets up a fresh matcher-owned contract instance with a matching, OPEN
  // buy/sell pair already created and their witness data registered — the
  // state a real Matcher would be in right before calling settle(). Callers
  // can override either side's details to construct failure scenarios.
  function makeMatchedPair(opts: {
    buyOverrides?: Partial<OrderDetailsValue>;
    sellOverrides?: Partial<OrderDetailsValue>;
  } = {}) {
    const c = makeContract();
    const buyId = bytes32(0x50);
    const sellId = bytes32(0x51);
    const buyBlinding = bytes32(0x52);
    const sellBlinding = bytes32(0x53);
    const buyDetails = sampleBuyOrder(opts.buyOverrides);
    const sellDetails = sampleSellOrder(opts.sellOverrides);
    const buyCommitment = computeCommitment(buyDetails, buyBlinding);
    const sellCommitment = computeCommitment(sellDetails, sellBlinding);

    c.createOrder(buyId, buyCommitment);
    c.createOrder(sellId, sellCommitment);
    c.registerWitness(buyId, buyDetails, buyBlinding);
    c.registerWitness(sellId, sellDetails, sellBlinding);

    return { c, buyId, sellId, buyDetails, sellDetails };
  }

  // ── settle() — success path ───────────────────────────────────────────────
  test('settle: fills a matching buy/sell pair and records the fill', () => {
    const { c, buyId, sellId } = makeMatchedPair();
    c.settle(buyId, sellId);

    assertEq(c.getOrder(buyId).state, OrderState.FILLED, 'buy order FILLED');
    assertEq(c.getOrder(sellId).state, OrderState.FILLED, 'sell order FILLED');

    const l = c.ledger();
    let filledEvents = 0;
    for (const [, event] of l.eventLog) {
      if (event.kind === EventKind.ORDER_FILLED) filledEvents++;
    }
    assertEq(filledEvents, 2, 'ORDER_FILLED recorded for both orders');
  });

  // ── settle() — failure paths ──────────────────────────────────────────────
  test('settle: rejects an asset mismatch between orders', () => {
    const { c, buyId, sellId } = makeMatchedPair({
      sellOverrides: { asset: bytes32(0xbb) },
    });
    assertThrows(() => c.settle(buyId, sellId), 'Asset mismatch between orders', 'asset mismatch');
  });

  test('settle: rejects an amount mismatch between orders', () => {
    const { c, buyId, sellId } = makeMatchedPair({ sellOverrides: { amount: 1n } });
    assertThrows(() => c.settle(buyId, sellId), 'Amount mismatch between orders', 'amount mismatch');
  });

  test('settle: rejects a buy price that does not cross the sell price', () => {
    const { c, buyId, sellId } = makeMatchedPair({ buyOverrides: { price: 900n }, sellOverrides: { price: 1_000n } });
    assertThrows(() => c.settle(buyId, sellId), 'Buy price does not cross sell price', 'non-crossing price');
  });

  test('settle: rejects two orders on the same side', () => {
    const { c, buyId, sellId } = makeMatchedPair({ sellOverrides: { isBuy: true } });
    assertThrows(() => c.settle(buyId, sellId), 'Sell order is not a sell-side order', 'same-side orders');
  });

  test('settle: rejects buy and sell orders from the same owner', () => {
    const { c, buyId, sellId } = makeMatchedPair({
      sellOverrides: { owner: { bytes: deriveOwnerId(Buffer.from(OWNER_SECRET_HEX, 'hex')) } },
    });
    assertThrows(
      () => c.settle(buyId, sellId),
      'Buy and sell orders must have different owners',
      'same-owner settlement',
    );
  });

  test('settle: rejects when one side is no longer OPEN', () => {
    // makeContract() defaults to OWNER_PK_HEX as caller, which owns the buy
    // side (see sampleBuyOrder) — so that's the side it's authorized to
    // cancel here.
    const { c, buyId, sellId } = makeMatchedPair();
    c.cancelOrder(buyId);
    assertThrows(() => c.settle(buyId, sellId), 'Buy order is not open', 'non-open buy side');
  });

  test('settle: rejects when the witnessed sell details do not match its commitment', () => {
    const { c, buyId, sellId, sellDetails } = makeMatchedPair();
    // Overwrite the sell side's registered witness with data that doesn't
    // hash to the commitment it was created with.
    c.registerWitness(sellId, { ...sellDetails, amount: sellDetails.amount + 1n }, bytes32(0x53));
    assertThrows(() => c.settle(buyId, sellId), 'Order commitment mismatch', 'sell commitment mismatch');
  });

  test('settle: a rejected settlement is fully atomic — it does not consume replay protection', () => {
    const { c, buyId, sellId } = makeMatchedPair({ sellOverrides: { amount: 1n } });
    assertThrows(() => c.settle(buyId, sellId), 'Amount mismatch between orders', 'first, failing attempt');

    // Re-register correct witness data and retry with a fresh matching pair
    // built the same way settle() expects; the earlier failure must not
    // have left behind a stale settledPairs entry or mutated order state.
    assertEq(c.getOrder(buyId).state, OrderState.OPEN, 'buy order still OPEN after failed settle');
    assertEq(c.getOrder(sellId).state, OrderState.OPEN, 'sell order still OPEN after failed settle');
  });

  // ── Replay protection ──────────────────────────────────────────────────────
  // Once a pair settles, both orders flip OPEN -> FILLED, so a replayed
  // settle() on the same pair is already rejected by the OPEN-state check
  // before it ever reaches the settledPairs nullifier check — the state
  // machine itself is the primary replay defense; settledPairs is
  // defense-in-depth for any future path that could re-settle without a
  // state transition. This test proves the pair cannot be replayed either
  // way.
  test('settle: rejects re-settling the same order pair (replay attack)', () => {
    const { c, buyId, sellId } = makeMatchedPair();
    c.settle(buyId, sellId);
    assertThrows(() => c.settle(buyId, sellId), 'is not open', 'replayed settlement');
  });

  // ── Expiry ─────────────────────────────────────────────────────────────────
  test('expireOrder: marks an order EXPIRED once its expiry time has passed', () => {
    const c = makeContract(OWNER_PK_HEX);
    const orderId = bytes32(0x60);
    const blinding = bytes32(0x61);
    const details = sampleOrder({ expiresAt: 1_000n });
    const commitment = computeCommitment(details, blinding);

    c.createOrder(orderId, commitment);
    c.registerWitness(orderId, details, blinding);
    c.expireOrder(orderId, 2_000);

    assertEq(c.getOrder(orderId).state, OrderState.EXPIRED, 'state == EXPIRED');
  });

  test('expireOrder: rejects expiring an order before its expiry time', () => {
    const c = makeContract(OWNER_PK_HEX);
    const orderId = bytes32(0x62);
    const blinding = bytes32(0x63);
    const details = sampleOrder({ expiresAt: 9_999_999_999n });
    const commitment = computeCommitment(details, blinding);

    c.createOrder(orderId, commitment);
    c.registerWitness(orderId, details, blinding);
    assertThrows(() => c.expireOrder(orderId, 1_000), 'Order has not expired yet', 'premature expiry');
  });

  test('expireOrder: rejects expiring an order that is not OPEN', () => {
    const c = makeContract(OWNER_PK_HEX);
    const orderId = bytes32(0x64);
    const blinding = bytes32(0x65);
    const details = sampleOrder({ expiresAt: 1_000n });
    const commitment = computeCommitment(details, blinding);

    c.createOrder(orderId, commitment);
    c.registerWitness(orderId, details, blinding);
    c.cancelOrder(orderId);
    assertThrows(() => c.expireOrder(orderId, 2_000), 'Order is not open', 'expire a cancelled order');
  });

  test('cancelOrder: rejects cancelling an order that has already expired', () => {
    const c = makeContract(OWNER_PK_HEX);
    const orderId = bytes32(0x66);
    const blinding = bytes32(0x67);
    const details = sampleOrder({ expiresAt: 1_000n });
    const commitment = computeCommitment(details, blinding);

    c.createOrder(orderId, commitment);
    c.registerWitness(orderId, details, blinding);
    c.expireOrder(orderId, 2_000);
    assertThrows(() => c.cancelOrder(orderId), 'Order is not open', 'cancel an expired order');
  });

  test('settle: rejects when the buy order has expired', () => {
    const { c, buyId, sellId } = makeMatchedPair({ buyOverrides: { expiresAt: 1_000n } });
    assertThrows(() => c.settle(buyId, sellId, 2_000), 'Buy order has expired', 'expired buy order');
  });

  test('settle: rejects when the sell order has expired', () => {
    const { c, buyId, sellId } = makeMatchedPair({ sellOverrides: { expiresAt: 1_000n } });
    assertThrows(() => c.settle(buyId, sellId, 2_000), 'Sell order has expired', 'expired sell order');
  });

  // ── settle() — same-id defense-in-depth ───────────────────────────────────
  test('settle: rejects settling an order id against itself', () => {
    const c = makeContract();
    const orderId = bytes32(0x80);
    const blinding = bytes32(0x81);
    const details = sampleOrder();
    const commitment = computeCommitment(details, blinding);
    c.createOrder(orderId, commitment);
    c.registerWitness(orderId, details, blinding);
    assertThrows(
      () => c.settle(orderId, orderId),
      'Buy and sell order ids must differ',
      'settle rejects buyId == sellId',
    );
  });

  // ── Boundary / overflow values ─────────────────────────────────────────────
  const UINT128_MAX = 340282366920938463463374607431768211455n;
  const UINT64_MAX = 18446744073709551615n;

  test('settle: fills at the maximum representable Uint<128> price and amount', () => {
    const { c, buyId, sellId } = makeMatchedPair({
      buyOverrides: { price: UINT128_MAX, amount: UINT128_MAX },
      sellOverrides: { price: UINT128_MAX, amount: UINT128_MAX },
    });
    c.settle(buyId, sellId);
    assertEq(c.getOrder(buyId).state, OrderState.FILLED, 'buy order FILLED at Uint<128> max');
    assertEq(c.getOrder(sellId).state, OrderState.FILLED, 'sell order FILLED at Uint<128> max');
  });

  test('createOrder/settle: accepts the maximum representable Uint<64> expiresAt without overflow', () => {
    // UINT64_MAX flows end-to-end as a bigint (struct field -> commitment ->
    // witness) with no lossy Number conversion, unlike the simulated block
    // time used elsewhere in this suite (which the runtime's
    // createCircuitContext takes as a plain `number`, so it cannot itself
    // represent UINT64_MAX exactly). This checks the boundary value the
    // type actually allows end-to-end, under an ordinary current time.
    const { c, buyId, sellId } = makeMatchedPair({
      buyOverrides: { expiresAt: UINT64_MAX },
      sellOverrides: { expiresAt: UINT64_MAX },
    });
    c.settle(buyId, sellId, 2_000);
    assertEq(c.getOrder(buyId).state, OrderState.FILLED, 'Uint<64> max expiresAt does not overflow settlement');
  });

  test('settle: crosses when buy price exactly equals sell price (boundary of >=)', () => {
    const { c, buyId, sellId } = makeMatchedPair({ buyOverrides: { price: 1_000n }, sellOverrides: { price: 1_000n } });
    c.settle(buyId, sellId);
    assertEq(c.getOrder(buyId).state, OrderState.FILLED, 'equal-price orders still cross and fill');
  });

  test('createOrder/cancelOrder: round-trips correctly with an all-zero orderId, commitment, and blinding', () => {
    const c = makeContract(OWNER_PK_HEX);
    const orderId = bytes32(0x00);
    const blinding = bytes32(0x00);
    const details = sampleOrder();
    const commitment = computeCommitment(details, blinding);
    c.createOrder(orderId, commitment);
    c.registerWitness(orderId, details, blinding);
    c.cancelOrder(orderId);
    assertEq(c.getOrder(orderId).state, OrderState.CANCELLED, 'all-zero-id order cancels normally');
  });

  // ─── Report ────────────────────────────────────────────────────────────────
  console.log('');
  let failCount = 0;
  for (const r of results) {
    if (r.pass) {
      console.log(`PASS  ${r.name}`);
    } else {
      failCount++;
      console.log(`FAIL  ${r.name}`);
      console.log(`      ${r.detail}`);
    }
  }
  console.log('');
  console.log(`${results.length - failCount}/${results.length} passed`);
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
