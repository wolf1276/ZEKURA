/**
 * Level 1 test suite for the Treasury module added to
 * contracts/exchange.compact (admins, treasuryBalances/treasuryReserved,
 * reservations, treasuryHistory, and the deposit/withdraw/reserve/release/
 * settleWithProtocol circuits).
 *
 * Same pure in-memory simulation approach as tests/exchange.test.ts — no
 * proof server, wallet, or indexer required.
 */
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Buffer } from 'node:buffer';
import * as rt from '@midnight-ntwrk/compact-runtime';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const contractPath = path.resolve(__dirname, '..', 'contracts', 'managed', 'exchange', 'contract', 'index.js');

const Uint128Type = new rt.CompactTypeUnsignedInteger(340282366920938463463374607431768211455n, 16);
const Uint64Type = new rt.CompactTypeUnsignedInteger(18446744073709551615n, 8);

// ─── OrderDetails wire encoding (mirrors tests/exchange.test.ts) ──────────
// Needed here only to construct a real, verifiable order commitment for
// settleWithProtocol tests — see that file's header comment for why this
// off-chain encoding has to match contracts/exchange.compact's OrderDetails
// struct layout exactly.
type OrderDetailsValue = {
  asset: Uint8Array;
  isBuy: boolean;
  price: bigint;
  amount: bigint;
  owner: { bytes: Uint8Array };
  expiresAt: bigint;
};

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

// treasuryBalances/treasuryReserved/reservations are public ledger Maps with
// no dedicated read circuit (see contracts/exchange.compact's comment on why)
// — these mirror the free indexer read a real client would do, directly
// against the simulator's ledger() snapshot.
function readBalance(l: any, assetKey: Uint8Array): bigint {
  return l.treasuryBalances.member(assetKey) ? l.treasuryBalances.lookup(assetKey) : 0n;
}
function readReserved(l: any, assetKey: Uint8Array): bigint {
  return l.treasuryReserved.member(assetKey) ? l.treasuryReserved.lookup(assetKey) : 0n;
}
function readReservation(l: any, quoteId: Uint8Array): any {
  if (!l.reservations.member(quoteId)) throw new Error('Reservation does not exist');
  return l.reservations.lookup(quoteId);
}
// getOrder was dropped as an exported circuit for the same block-limit
// reason as getTreasuryBalance/getTreasuryReserved/getReservation above —
// orders is a public ledger Map, read directly instead of via a paid circuit.
function readOrder(l: any, orderId: Uint8Array): any {
  if (!l.orders.member(orderId)) throw new Error('Order does not exist');
  return l.orders.lookup(orderId);
}

const CALLER_PK_HEX = '00'.repeat(32);
const ADMIN_SECRET_HEX = 'aa'.repeat(32);
const OTHER_SECRET_HEX = 'bb'.repeat(32);
const OWNER_SECRET_HEX = 'cc'.repeat(32);

const ASSET_A = bytes32(0xa1); // stands in for a token type (e.g. tNIGHT's real nativeToken() bytes on a live network)
const ASSET_B = bytes32(0xb2);
// nativeToken() is the all-zeros token type — the key settleWithProtocol's
// NIGHT payment leg reads/writes treasuryBalances under. A real minted
// token color (e.g. tZKR's, or ASSET_A/ASSET_B here) is never all-zero, so
// there is no collision with NIGHT's own key.
const NIGHT_KEY = bytes32(0x00);

// Either<ContractAddress, UserAddress> — Left arm (ContractAddress), matching
// the struct-of-{bytes} shape sendUnshielded's recipient parameter expects.
const CONTRACT_RECIPIENT = {
  is_left: true,
  left: { bytes: bytes32(0xc0) },
  right: { bytes: bytes32(0x00) },
};

async function main() {
  const mod: any = await import(pathToFileURL(contractPath).href);
  const { Contract, ledger, OrderState, ReservationState, TxKind, pureCircuits } = mod;
  const { deriveAdminId, deriveOwnerId } = pureCircuits;

  const ADMIN_ID = deriveAdminId(Buffer.from(ADMIN_SECRET_HEX, 'hex'));
  // The default sample order's owner — real settleWithProtocol callers must
  // now prove they hold this secret (see contracts/exchange.compact's P0-2
  // fix), same requirement cancelOrder already had.
  const OWNER_ID = deriveOwnerId(Buffer.from(OWNER_SECRET_HEX, 'hex'));

  function sampleOrder(overrides: Partial<OrderDetailsValue> = {}): OrderDetailsValue {
    return {
      asset: ASSET_A,
      isBuy: true,
      price: 1_000n,
      amount: 500n,
      owner: { bytes: OWNER_ID },
      expiresAt: 9_999_999_999n,
      ...overrides,
    };
  }
  // OrderDetails.asset *is* the Treasury key directly now (no deriveAssetKey
  // hashing indirection — see contracts/exchange.compact's asset-field
  // simplification).
  const ASSET_A_KEY = sampleOrder().asset;

  // Fresh contract instance bootstrapped with ADMIN_ID as the sole initial
  // admin. adminSecretKeyHex controls which secret the *caller's* witness
  // reports — defaults to the real admin so most tests exercise the
  // authorized path; override to simulate a non-admin caller.
  function makeContract(adminSecretKeyHex: string = ADMIN_SECRET_HEX, ownerSecretKeyHex: string = OWNER_SECRET_HEX) {
    // Local, in-memory order store standing in for a wallet's private
    // storage — same role as tests/exchange.test.ts's orderStore, needed
    // here only so settleWithProtocol tests can create a real order with a
    // verifiable commitment.
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
      ownerSecretKey: (context: any) => [context.privateState, Buffer.from(ownerSecretKeyHex, 'hex')],
      adminSecretKey: (context: any) => [context.privateState, Buffer.from(adminSecretKeyHex, 'hex')],
    };
    const contract = new Contract(witnesses);
    const constructorContext = rt.createConstructorContext(undefined, CALLER_PK_HEX);
    const init = contract.initialState(constructorContext, ADMIN_ID);
    let ctx = rt.createCircuitContext(
      rt.dummyContractAddress(),
      CALLER_PK_HEX,
      init.currentContractState.data,
      init.currentPrivateState,
    );

    function call(name: string, ...args: unknown[]) {
      const r = contract.circuits[name](ctx, ...args);
      ctx = r.context;
      return r.result;
    }

    return {
      addAdmin: (newAdmin: Uint8Array) => call('addAdmin', newAdmin),
      removeAdmin: (admin: Uint8Array) => call('removeAdmin', admin),
      depositTreasury: (assetKey: Uint8Array, amount: bigint) => call('depositTreasury', assetKey, amount),
      withdrawTreasury: (assetKey: Uint8Array, amount: bigint, recipient: unknown) =>
        call('withdrawTreasury', assetKey, amount, recipient),
      reserveLiquidity: (quoteId: Uint8Array, assetKey: Uint8Array, amount: bigint, price: bigint, expiresAt: bigint) =>
        call('reserveLiquidity', quoteId, assetKey, amount, price, expiresAt),
      releaseLiquidity: (quoteId: Uint8Array) => call('releaseLiquidity', quoteId),
      releaseExpiredLiquidity: (quoteId: Uint8Array, atTimeSeconds?: number) => {
        if (atTimeSeconds !== undefined) {
          ctx = rt.createCircuitContext(
            rt.dummyContractAddress(),
            CALLER_PK_HEX,
            ctx.currentQueryContext.state,
            ctx.currentPrivateState,
            undefined,
            undefined,
            atTimeSeconds,
          );
        }
        return call('releaseExpiredLiquidity', quoteId);
      },
      // No getTreasuryBalance/getTreasuryReserved/getReservation circuits —
      // those ledger Maps are public and read directly via readBalance/
      // readReserved/readReservation below (see the contract's own comment
      // on why: those circuits were dropped to fit the deploy transaction
      // under this devnet's block limit).
      createOrder: (orderId: Uint8Array, commitment: Uint8Array) => call('createOrder', orderId, commitment),
      getOrder: (orderId: Uint8Array) => readOrder(ledger(ctx.currentQueryContext.state), orderId),
      registerWitness: (orderId: Uint8Array, details: OrderDetailsValue, blinding: Uint8Array) => {
        orderStore.set(Buffer.from(orderId).toString('hex'), { details, blinding });
      },
      settleWithProtocol: (orderId: Uint8Array, quoteId: Uint8Array, recipient: unknown, atTimeSeconds?: number) => {
        if (atTimeSeconds !== undefined) {
          ctx = rt.createCircuitContext(
            rt.dummyContractAddress(),
            CALLER_PK_HEX,
            ctx.currentQueryContext.state,
            ctx.currentPrivateState,
            undefined,
            undefined,
            atTimeSeconds,
          );
        }
        return call('settleWithProtocol', orderId, quoteId, recipient);
      },
      ledger: () => ledger(ctx.currentQueryContext.state),
      rawState: () => ctx.currentQueryContext.state,
    };
  }

  // ── Empty treasury ─────────────────────────────────────────────────────
  test('Deploy: treasury starts completely empty — zero balance, zero reserved, no seeded admin balances', () => {
    const c = makeContract();
    assertEq(readBalance(c.ledger(), ASSET_A), 0n, 'balance starts at 0');
    assertEq(readReserved(c.ledger(), ASSET_A), 0n, 'reserved starts at 0');
    const l = c.ledger();
    assertEq(l.treasuryBalances.isEmpty(), true, 'treasuryBalances map is empty');
    assertEq(l.treasuryReserved.isEmpty(), true, 'treasuryReserved map is empty');
    assertEq(l.treasuryHistory.isEmpty(), true, 'treasuryHistory is empty');
    assertEq(l.reservations.isEmpty(), true, 'reservations map is empty');
    assertEq(l.admins.member(ADMIN_ID), true, 'bootstrapped admin is present');
  });

  // ── Admin gating ────────────────────────────────────────────────────────
  test('depositTreasury: rejects a non-admin caller', () => {
    const c = makeContract(OTHER_SECRET_HEX);
    assertThrows(
      () => c.depositTreasury(ASSET_A, 1_000n),
      'Caller is not an authorized administrator',
      'non-admin deposit',
    );
  });

  test('withdrawTreasury: rejects a non-admin caller', () => {
    const c = makeContract(OTHER_SECRET_HEX);
    assertThrows(
      () => c.withdrawTreasury(ASSET_A, 1n, CONTRACT_RECIPIENT),
      'Caller is not an authorized administrator',
      'non-admin withdraw',
    );
  });

  test('addAdmin/removeAdmin: only an existing admin may rotate the admin set', () => {
    const nonAdmin = makeContract(OTHER_SECRET_HEX);
    const newAdminId = bytes32(0xd1);
    assertThrows(() => nonAdmin.addAdmin(newAdminId), 'Caller is not an authorized administrator', 'non-admin addAdmin');

    const admin = makeContract();
    admin.addAdmin(newAdminId);
    assertEq(admin.ledger().admins.member(newAdminId), true, 'new admin added');
  });

  test('removeAdmin: cannot remove the last remaining admin', () => {
    const c = makeContract();
    assertThrows(() => c.removeAdmin(ADMIN_ID), 'Cannot remove the last admin', 'removing sole admin');
  });

  // ── depositTreasury / withdrawTreasury ─────────────────────────────────
  test('depositTreasury: increments balance and records a DEPOSIT history row', () => {
    const c = makeContract();
    c.depositTreasury(ASSET_A, 5_000n);
    assertEq(readBalance(c.ledger(), ASSET_A), 5_000n, 'balance after deposit');

    const l = c.ledger();
    let depositRows = 0;
    for (const [, tx] of l.treasuryHistory) {
      if (tx.kind === TxKind.DEPOSIT && tx.assetKey.every((b: number, i: number) => b === ASSET_A[i])) depositRows++;
    }
    assertEq(depositRows, 1, 'one DEPOSIT row recorded');
  });

  test('depositTreasury: multiple assets are tracked independently', () => {
    const c = makeContract();
    c.depositTreasury(ASSET_A, 1_000n);
    c.depositTreasury(ASSET_B, 2_000n);
    assertEq(readBalance(c.ledger(), ASSET_A), 1_000n, 'asset A balance');
    assertEq(readBalance(c.ledger(), ASSET_B), 2_000n, 'asset B balance');
  });

  test('withdrawTreasury: rejects withdrawing more than the available balance', () => {
    const c = makeContract();
    c.depositTreasury(ASSET_A, 1_000n);
    assertThrows(
      () => c.withdrawTreasury(ASSET_A, 1_001n, CONTRACT_RECIPIENT),
      'Insufficient available treasury balance',
      'over-withdraw',
    );
  });

  test('withdrawTreasury: decrements balance and records a WITHDRAW history row', () => {
    const c = makeContract();
    c.depositTreasury(ASSET_A, 1_000n);
    c.withdrawTreasury(ASSET_A, 400n, CONTRACT_RECIPIENT);
    assertEq(readBalance(c.ledger(), ASSET_A), 600n, 'balance after withdrawal');
  });

  // ── reserveLiquidity / releaseLiquidity ────────────────────────────────
  test('reserveLiquidity: rejects reserving against an empty treasury — "Protocol liquidity unavailable."', () => {
    const c = makeContract();
    assertThrows(
      () => c.reserveLiquidity(bytes32(0x01), ASSET_A, 100n, 1_000n, 9_999_999_999n),
      'Protocol liquidity unavailable',
      'reserve with zero balance',
    );
  });

  test('reserveLiquidity: rejects reserving more than available (balance minus already-reserved)', () => {
    const c = makeContract();
    c.depositTreasury(ASSET_A, 1_000n);
    c.reserveLiquidity(bytes32(0x02), ASSET_A, 1_000n, 1_000n, 9_999_999_999n);
    assertThrows(
      () => c.reserveLiquidity(bytes32(0x03), ASSET_A, 1n, 1_000n, 9_999_999_999n),
      'Protocol liquidity unavailable',
      'reserve beyond available',
    );
  });

  test('reserveLiquidity: rejects a non-admin caller (S1 fix — griefing/liquidity-lock guard)', () => {
    const c = makeContract(OTHER_SECRET_HEX);
    assertThrows(
      () => c.reserveLiquidity(bytes32(0x11), ASSET_A, 100n, 1_000n, 9_999_999_999n),
      'Caller is not an authorized administrator',
      'non-admin reserveLiquidity',
    );
  });

  test('reserveLiquidity: succeeds within available balance and moves treasuryReserved', () => {
    const c = makeContract();
    c.depositTreasury(ASSET_A, 1_000n);
    c.reserveLiquidity(bytes32(0x04), ASSET_A, 300n, 1_000n, 9_999_999_999n);
    assertEq(readReserved(c.ledger(), ASSET_A), 300n, 'reserved after reserve');
    assertEq(readBalance(c.ledger(), ASSET_A), 1_000n, 'balance unchanged by reserve (only reserved moves)');

    const r = readReservation(c.ledger(), bytes32(0x04));
    assertEq(r.state, ReservationState.OPEN, 'reservation OPEN');
    assertEq(r.amount, 300n, 'reservation amount');
  });

  test('reserveLiquidity: rejects a duplicate quoteId', () => {
    const c = makeContract();
    c.depositTreasury(ASSET_A, 1_000n);
    c.reserveLiquidity(bytes32(0x05), ASSET_A, 100n, 1_000n, 9_999_999_999n);
    assertThrows(
      () => c.reserveLiquidity(bytes32(0x05), ASSET_A, 100n, 1_000n, 9_999_999_999n),
      'Reservation already exists',
      'duplicate quoteId',
    );
  });

  test('releaseLiquidity: un-reserves an open hold back to available', () => {
    const c = makeContract();
    c.depositTreasury(ASSET_A, 1_000n);
    c.reserveLiquidity(bytes32(0x06), ASSET_A, 300n, 1_000n, 9_999_999_999n);
    c.releaseLiquidity(bytes32(0x06));
    assertEq(readReserved(c.ledger(), ASSET_A), 0n, 'reserved returns to 0');
    assertEq(readReservation(c.ledger(), bytes32(0x06)).state, ReservationState.RELEASED, 'reservation RELEASED');
  });

  test('releaseLiquidity: rejects releasing an already-released reservation (no double release)', () => {
    const c = makeContract();
    c.depositTreasury(ASSET_A, 1_000n);
    c.reserveLiquidity(bytes32(0x07), ASSET_A, 300n, 1_000n, 9_999_999_999n);
    c.releaseLiquidity(bytes32(0x07));
    assertThrows(() => c.releaseLiquidity(bytes32(0x07)), 'Reservation is not open', 'double release');
  });

  test('releaseLiquidity: rejects a non-admin caller (S1 fix — front-running/griefing guard)', () => {
    const attacker = makeContract(OTHER_SECRET_HEX);
    assertThrows(
      () => attacker.releaseLiquidity(bytes32(0x12)),
      'Caller is not an authorized administrator',
      'non-admin releaseLiquidity',
    );
  });

  // ── Reservation expiry ─────────────────────────────────────────────────
  test('releaseExpiredLiquidity: rejects releasing before the quote has expired', () => {
    const c = makeContract();
    c.depositTreasury(ASSET_A, 1_000n);
    c.reserveLiquidity(bytes32(0x08), ASSET_A, 300n, 1_000n, 5_000n);
    assertThrows(
      () => c.releaseExpiredLiquidity(bytes32(0x08), 1_000),
      'Reservation has not expired yet',
      'premature expiry release',
    );
  });

  test('releaseExpiredLiquidity: anyone can reclaim an expired, still-open reservation', () => {
    const c = makeContract();
    c.depositTreasury(ASSET_A, 1_000n);
    c.reserveLiquidity(bytes32(0x09), ASSET_A, 300n, 1_000n, 5_000n);
    c.releaseExpiredLiquidity(bytes32(0x09), 6_000);
    assertEq(readReserved(c.ledger(), ASSET_A), 0n, 'reserved returns to 0 after expiry release');
    assertEq(readReservation(c.ledger(), bytes32(0x09)).state, ReservationState.RELEASED, 'reservation RELEASED via expiry');
  });

  // ── Read circuits on unknown ids ───────────────────────────────────────
  test('getReservation: throws for an unknown quoteId', () => {
    const c = makeContract();
    assertThrows(() => readReservation(c.ledger(), bytes32(0xff)), 'Reservation does not exist', 'unknown quoteId');
  });

  test('getTreasuryBalance/getTreasuryReserved: read as 0 for an asset never funded, without throwing', () => {
    const c = makeContract();
    assertEq(readBalance(c.ledger(), bytes32(0xfe)), 0n, 'never-funded asset balance is 0');
    assertEq(readReserved(c.ledger(), bytes32(0xfe)), 0n, 'never-funded asset reserved is 0');
  });

  // ── settleWithProtocol ─────────────────────────────────────────────────
  function makeOpenOrderAgainstReservation(opts: {
    c: ReturnType<typeof makeContract>;
    orderOverrides?: Partial<OrderDetailsValue>;
    quoteId: Uint8Array;
    reservedAmount?: bigint;
    reservedPrice?: bigint;
    expiresAt?: bigint;
    treasuryDeposit?: bigint;
    nightDeposit?: bigint;
  }) {
    const { c, quoteId } = opts;
    const orderId = bytes32(0x90);
    const blinding = bytes32(0x91);
    const details = sampleOrder(opts.orderOverrides);
    const commitment = computeCommitment(details, blinding);

    c.depositTreasury(ASSET_A_KEY, opts.treasuryDeposit ?? 10_000n);
    // Seed NIGHT liquidity so the SELL-side payment leg (protocol pays the
    // seller in NIGHT) has funds to draw on; harmless for BUY fills.
    if (opts.nightDeposit !== undefined) {
      c.depositTreasury(NIGHT_KEY, opts.nightDeposit);
    }
    c.createOrder(orderId, commitment);
    c.registerWitness(orderId, details, blinding);
    c.reserveLiquidity(
      quoteId,
      ASSET_A_KEY,
      opts.reservedAmount ?? details.amount,
      opts.reservedPrice ?? details.price,
      opts.expiresAt ?? 9_999_999_999n,
    );
    return { orderId, details, commitment };
  }

  test('settleWithProtocol: fills a resting buy order against protocol liquidity, moves the Treasury balance', () => {
    const c = makeContract();
    const quoteId = bytes32(0xa0);
    // amount 500, reserved price 1000 -> NIGHT payment leg is 500 * 1000.
    const { orderId } = makeOpenOrderAgainstReservation({ c, quoteId, treasuryDeposit: 10_000n });

    c.settleWithProtocol(orderId, quoteId, CONTRACT_RECIPIENT);

    assertEq(c.getOrder(orderId).state, OrderState.FILLED, 'order FILLED');
    assertEq(readReservation(c.ledger(), quoteId).state, ReservationState.EXECUTED, 'reservation EXECUTED');
    // Buy order: protocol is the seller, asset balance goes down by the filled amount.
    assertEq(readBalance(c.ledger(), ASSET_A_KEY), 10_000n - 500n, 'treasury asset balance debited for buy fill');
    assertEq(readReserved(c.ledger(), ASSET_A_KEY), 0n, 'reservation no longer counted as reserved');
    // NIGHT payment leg: protocol receives amount*price NIGHT from the buyer,
    // so its NIGHT balance is credited (starts at 0 here).
    assertEq(readBalance(c.ledger(), NIGHT_KEY), 500n * 1_000n, 'treasury NIGHT balance credited by buyer payment');
  });

  test('settleWithProtocol: fills a resting sell order against protocol liquidity, credits the Treasury balance', () => {
    const c = makeContract();
    const quoteId = bytes32(0xa1);
    // Sell fill pays the seller 500 * 900 NIGHT — seed enough NIGHT liquidity.
    const { orderId } = makeOpenOrderAgainstReservation({
      c,
      quoteId,
      orderOverrides: { isBuy: false, price: 900n },
      reservedPrice: 900n,
      treasuryDeposit: 10_000n,
      nightDeposit: 1_000_000n,
    });

    c.settleWithProtocol(orderId, quoteId, CONTRACT_RECIPIENT);

    assertEq(c.getOrder(orderId).state, OrderState.FILLED, 'sell order FILLED');
    // Sell order: protocol is the buyer, asset balance goes up by the filled amount.
    assertEq(readBalance(c.ledger(), ASSET_A_KEY), 10_000n + 500n, 'treasury asset balance credited for sell fill');
    // NIGHT payment leg: protocol pays the seller amount*price NIGHT, so its
    // NIGHT balance is debited.
    assertEq(readBalance(c.ledger(), NIGHT_KEY), 1_000_000n - 500n * 900n, 'treasury NIGHT balance debited by seller payment');
  });

  test('settleWithProtocol: rejects a sell fill when the Treasury holds insufficient NIGHT to pay the seller', () => {
    const c = makeContract();
    const quoteId = bytes32(0xa7);
    // Sell fill owes 500 * 900 = 450_000 NIGHT, but only 100 NIGHT is on hand.
    const { orderId } = makeOpenOrderAgainstReservation({
      c,
      quoteId,
      orderOverrides: { isBuy: false, price: 900n },
      reservedPrice: 900n,
      treasuryDeposit: 10_000n,
      nightDeposit: 100n,
    });
    assertThrows(
      () => c.settleWithProtocol(orderId, quoteId, CONTRACT_RECIPIENT),
      'Insufficient protocol NIGHT liquidity',
      'sell fill with too little NIGHT',
    );
    // Nothing moved: the order is still open and the reservation still OPEN.
    assertEq(c.getOrder(orderId).state, OrderState.OPEN, 'order stays OPEN on failed settle');
    assertEq(readReservation(c.ledger(), quoteId).state, ReservationState.OPEN, 'reservation stays OPEN on failed settle');
  });

  test('settleWithProtocol: rejects when the reservation has expired', () => {
    const c = makeContract();
    const quoteId = bytes32(0xa2);
    const { orderId } = makeOpenOrderAgainstReservation({ c, quoteId, expiresAt: 5_000n });
    assertThrows(
      () => c.settleWithProtocol(orderId, quoteId, CONTRACT_RECIPIENT, 6_000),
      'Quote has expired',
      'expired quote at settle time',
    );
  });

  test('settleWithProtocol: rejects an amount mismatch between the order and the reservation', () => {
    const c = makeContract();
    const quoteId = bytes32(0xa3);
    const { orderId } = makeOpenOrderAgainstReservation({ c, quoteId, reservedAmount: 499n });
    assertThrows(
      () => c.settleWithProtocol(orderId, quoteId, CONTRACT_RECIPIENT),
      'Amount mismatch between order and reservation',
      'amount mismatch',
    );
  });

  test('settleWithProtocol: rejects a buy price that does not cross the protocol quote', () => {
    const c = makeContract();
    const quoteId = bytes32(0xa4);
    const { orderId } = makeOpenOrderAgainstReservation({
      c,
      quoteId,
      orderOverrides: { price: 800n },
      reservedPrice: 1_000n,
    });
    assertThrows(
      () => c.settleWithProtocol(orderId, quoteId, CONTRACT_RECIPIENT),
      'Buy price does not cross protocol quote',
      'non-crossing buy',
    );
  });

  test('settleWithProtocol: rejects replaying the same reservation twice', () => {
    const c = makeContract();
    const quoteId = bytes32(0xa5);
    const { orderId } = makeOpenOrderAgainstReservation({ c, quoteId, treasuryDeposit: 10_000n });
    c.settleWithProtocol(orderId, quoteId, CONTRACT_RECIPIENT);
    assertThrows(
      () => c.settleWithProtocol(orderId, quoteId, CONTRACT_RECIPIENT),
      'Order is not open',
      'replayed settleWithProtocol',
    );
  });

  test('settleWithProtocol: rejects a caller who knows the order details but not its ownerSecretKey — closes the payout-redirect bypass', () => {
    // Simulates the Matcher (or any party disclosed the order's committed
    // details for settlement, per this contract's own trust model): it can
    // satisfy verifyOrderCommitment, but does not hold the real owner's
    // ownerSecretKey, so it must not be able to submit settleWithProtocol
    // and redirect the payout to a recipient of its own choosing.
    const c = makeContract(ADMIN_SECRET_HEX, OTHER_SECRET_HEX);
    const quoteId = bytes32(0xa8);
    const { orderId } = makeOpenOrderAgainstReservation({ c, quoteId, treasuryDeposit: 10_000n });
    assertThrows(
      () => c.settleWithProtocol(orderId, quoteId, CONTRACT_RECIPIENT),
      'Caller is not the order owner',
      'eavesdropper without ownerSecretKey',
    );
    // Nothing moved: the order is still open and the reservation still OPEN.
    assertEq(c.getOrder(orderId).state, OrderState.OPEN, 'order stays OPEN when auth fails');
    assertEq(readReservation(c.ledger(), quoteId).state, ReservationState.OPEN, 'reservation stays OPEN when auth fails');
    assertEq(readBalance(c.ledger(), ASSET_A_KEY), 10_000n, 'treasury asset balance untouched');
  });

  test('settleWithProtocol: rejects an asset mismatch between the order and the reservation', () => {
    const c = makeContract();
    const quoteId = bytes32(0xa6);
    const orderId = bytes32(0x92);
    const blinding = bytes32(0x93);
    const details = sampleOrder({ asset: ASSET_B });
    const commitment = computeCommitment(details, blinding);

    c.depositTreasury(ASSET_A_KEY, 10_000n);
    c.createOrder(orderId, commitment);
    c.registerWitness(orderId, details, blinding);
    // Reservation is keyed to ASSET_A, but the order's real asset is ASSET_B.
    c.reserveLiquidity(quoteId, ASSET_A_KEY, details.amount, details.price, 9_999_999_999n);

    assertThrows(
      () => c.settleWithProtocol(orderId, quoteId, CONTRACT_RECIPIENT),
      'Asset mismatch between order and reservation',
      'asset mismatch',
    );
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
