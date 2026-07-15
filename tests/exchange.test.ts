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
  asset: { is_left: boolean; left: Uint8Array; right: Uint8Array };
  isBuy: boolean;
  price: bigint;
  amount: bigint;
  owner: { bytes: Uint8Array };
  expiresAt: bigint;
};

const Uint128Type = new rt.CompactTypeUnsignedInteger(340282366920938463463374607431768211455n, 16);
const Uint64Type = new rt.CompactTypeUnsignedInteger(18446744073709551615n, 8);

class EitherBytes32Type implements rt.CompactType<{ is_left: boolean; left: Uint8Array; right: Uint8Array }> {
  alignment() {
    return rt.CompactTypeBoolean.alignment().concat(
      rt.Bytes32Descriptor.alignment().concat(rt.Bytes32Descriptor.alignment()),
    );
  }
  fromValue(value: rt.Value) {
    return {
      is_left: rt.CompactTypeBoolean.fromValue(value),
      left: rt.Bytes32Descriptor.fromValue(value),
      right: rt.Bytes32Descriptor.fromValue(value),
    };
  }
  toValue(v: { is_left: boolean; left: Uint8Array; right: Uint8Array }) {
    return rt.CompactTypeBoolean.toValue(v.is_left).concat(
      rt.Bytes32Descriptor.toValue(v.left).concat(rt.Bytes32Descriptor.toValue(v.right)),
    );
  }
}
const eitherType = new EitherBytes32Type();

class OrderDetailsType implements rt.CompactType<OrderDetailsValue> {
  alignment() {
    return eitherType
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
      asset: eitherType.fromValue(value),
      isBuy: rt.CompactTypeBoolean.fromValue(value),
      price: Uint128Type.fromValue(value),
      amount: Uint128Type.fromValue(value),
      owner: rt.ZswapCoinPublicKeyDescriptor.fromValue(value),
      expiresAt: Uint64Type.fromValue(value),
    };
  }
  toValue(v: OrderDetailsValue) {
    return eitherType
      .toValue(v.asset)
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

async function main() {
  const mod: any = await import(pathToFileURL(contractPath).href);
  const { Contract, ledger, OrderState } = mod;

  // Fresh contract instance whose orderDetails/orderBlinding witnesses read
  // from a local, in-memory order store — standing in for the wallet's own
  // private storage. Nothing here is ever written to the ledger; it's only
  // ever read back by the circuits that need to re-verify a commitment.
  function makeContract(callerPkHex: string = OWNER_PK_HEX) {
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
    };
    const contract = new Contract(witnesses);
    const constructorContext = rt.createConstructorContext(undefined, callerPkHex);
    const init = contract.initialState(constructorContext);
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
      getOrder(orderId: Uint8Array) {
        const r = contract.circuits.getOrder(ctx, orderId);
        ctx = r.context;
        return r.result;
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
      // Calls cancelOrder as a different caller (different ownPublicKey()),
      // against the same ledger snapshot, without merging the result back —
      // used only for the unauthorized-cancel negative test.
      cancelOrderAsOtherCaller(otherPkHex: string, orderId: Uint8Array) {
        const otherCtx = rt.createCircuitContext(
          rt.dummyContractAddress(),
          otherPkHex,
          ctx.currentQueryContext.state,
          ctx.currentPrivateState,
        );
        contract.circuits.cancelOrder(otherCtx, orderId);
      },
    };
  }

  function sampleOrder(overrides: Partial<OrderDetailsValue> = {}): OrderDetailsValue {
    return {
      asset: { is_left: true, left: bytes32(0xaa), right: bytes32(0x00) },
      isBuy: true,
      price: 1_000n,
      amount: 123_456_789n,
      owner: { bytes: Buffer.from(OWNER_PK_HEX, 'hex') },
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

  test('cancelOrder: rejects a caller who is not the order owner', () => {
    const c = makeContract(OWNER_PK_HEX);
    const orderId = bytes32(0x13);
    const blinding = bytes32(0x14);
    const details = sampleOrder(); // owner.bytes == OWNER_PK_HEX
    const commitment = computeCommitment(details, blinding);

    c.createOrder(orderId, commitment);
    c.registerWitness(orderId, details, blinding);

    assertThrows(
      () => c.cancelOrderAsOtherCaller(OTHER_PK_HEX, orderId),
      'Caller is not the order owner',
      'non-owner cancel',
    );
    // Rejected call must not have mutated the primary ledger.
    assertEq(c.getOrder(orderId).state, OrderState.OPEN, 'status unchanged after rejected cancel');
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
    // details — only orders/settledPairs/eventLog, matching the "public
    // ledger stores ONLY orderId, commitment, state" architecture rule.
    assertEq(
      JSON.stringify(Object.keys(l).sort()),
      JSON.stringify(['eventLog', 'orders', 'settledPairs']),
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
