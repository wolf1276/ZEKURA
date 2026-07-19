import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BootstrapPriceRepository } from '../../src/db/repositories/BootstrapPriceRepository.js';
import { MatchRepository } from '../../src/db/repositories/MatchRepository.js';
import { OrderRepository } from '../../src/db/repositories/OrderRepository.js';
import { openDatabase } from '../../src/db/sqlite.js';
import { MatchingEngine } from '../../src/matcher/MatchingEngine.js';
import { PriceTimePriorityStrategy } from '../../src/matcher/MatchingStrategy.js';
import { OrderBook } from '../../src/orderbook/OrderBook.js';
import { OrderService } from '../../src/services/OrderService.js';
import type { OnChainOrderReader, OnChainOrderRecord } from '../../src/settlement/SettlementClient.js';
import type { CreateOrderInput } from '../../src/utils/validation.js';
import { computeCommitmentHex, toOrderDetailsValue } from '../../src/utils/orderDetailsCodec.js';
import { createLogger } from '../../src/utils/logger.js';
import type { Broadcaster } from '../../src/websocket/SocketServer.js';
import type { PPMService, PpmFillOutcome } from '../../src/ppm/PPMService.js';

const logger = createLogger('test', { level: 'silent' });

function hexFill(byte: string): string {
  return byte.repeat(32);
}

const ASSET = hexFill('aa');

interface DraftOpts {
  id: string;
  side: 'BUY' | 'SELL';
  price: bigint;
  amount: bigint;
  ownerId: string;
  signature: string;
  expiresAt?: bigint;
  asset?: typeof ASSET;
}

function buildInput(opts: DraftOpts): CreateOrderInput {
  const asset = opts.asset ?? ASSET;
  const expiresAt = opts.expiresAt ?? 9_999_999_999n;
  const details = toOrderDetailsValue({ asset, side: opts.side, price: opts.price, amount: opts.amount, ownerId: opts.ownerId, expiresAt });
  const commitment = computeCommitmentHex(details, opts.signature);
  return {
    id: opts.id,
    asset,
    side: opts.side,
    price: opts.price,
    amount: opts.amount,
    commitment,
    ownerId: opts.ownerId,
    signature: opts.signature,
    expiresAt,
    payoutAddress: null,
  };
}

class FakeOnChainReader implements OnChainOrderReader {
  private readonly registry = new Map<string, OnChainOrderRecord>();

  register(id: string, record: OnChainOrderRecord): void {
    this.registry.set(id, record);
  }

  async getOrder(orderId: string): Promise<OnChainOrderRecord> {
    return this.registry.get(orderId) ?? { state: 'NOT_FOUND', commitment: null };
  }
}

function makeHarness() {
  const db = openDatabase(':memory:');
  const orderRepo = new OrderRepository(db);
  const matchRepo = new MatchRepository(db);
  const bootstrapPriceRepo = new BootstrapPriceRepository(db);
  const orderBook = new OrderBook();
  const matchingEngine = new MatchingEngine(orderBook, new PriceTimePriorityStrategy());
  const onChainReader = new FakeOnChainReader();
  const events: Array<[string, unknown]> = [];
  const broadcaster: Broadcaster = { broadcast: (type, payload) => events.push([type, payload]) };
  const onMatch = vi.fn();

  const service = new OrderService({
    db,
    orderRepo,
    matchRepo,
    orderBook,
    matchingEngine,
    onChainReader,
    broadcaster,
    logger,
    onMatch,
    bootstrapPriceRepo,
  });

  return { db, orderRepo, matchRepo, bootstrapPriceRepo, orderBook, onChainReader, events, onMatch, service };
}

describe('OrderService.submitOrder', () => {
  let harness: ReturnType<typeof makeHarness>;

  beforeEach(() => {
    harness = makeHarness();
  });

  it('accepts a valid order whose commitment matches the on-chain record', async () => {
    const input = buildInput({ id: hexFill('01'), side: 'BUY', price: 100n, amount: 10n, ownerId: hexFill('aa'), signature: hexFill('11') });
    harness.onChainReader.register(input.id, { state: 'OPEN', commitment: input.commitment });

    const result = await harness.service.submitOrder(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.order.status).toBe('OPEN');
      expect(result.match).toBeNull();
    }
    expect(harness.orderBook.has(input.id)).toBe(true);
    expect(harness.events.map(([t]) => t)).toEqual(['order.created']);
  });

  it('rejects a duplicate order id', async () => {
    const input = buildInput({ id: hexFill('01'), side: 'BUY', price: 100n, amount: 10n, ownerId: hexFill('aa'), signature: hexFill('11') });
    harness.onChainReader.register(input.id, { state: 'OPEN', commitment: input.commitment });
    await harness.service.submitOrder(input);

    const result = await harness.service.submitOrder(input);
    expect(result).toMatchObject({ ok: false, code: 'DUPLICATE' });
  });

  it('re-throws an insert failure that is not a duplicate-id race (a genuine DB error)', async () => {
    const input = buildInput({ id: hexFill('01'), side: 'BUY', price: 100n, amount: 10n, ownerId: hexFill('aa'), signature: hexFill('11') });
    harness.onChainReader.register(input.id, { state: 'OPEN', commitment: input.commitment });
    const spy = vi.spyOn(harness.orderRepo, 'insert').mockImplementation(() => {
      throw new Error('disk I/O error');
    });

    await expect(harness.service.submitOrder(input)).rejects.toThrow('disk I/O error');
    spy.mockRestore();
  });

  it('rejects when the recomputed commitment does not match the supplied commitment (tampered/invalid signature)', async () => {
    const input = buildInput({ id: hexFill('01'), side: 'BUY', price: 100n, amount: 10n, ownerId: hexFill('aa'), signature: hexFill('11') });
    const tampered = { ...input, amount: 999n }; // amount changed after commitment was computed
    const result = await harness.service.submitOrder(tampered);
    expect(result).toMatchObject({ ok: false, code: 'SIGNATURE_INVALID' });
  });

  it('rejects an order with no matching on-chain createOrder', async () => {
    const input = buildInput({ id: hexFill('01'), side: 'BUY', price: 100n, amount: 10n, ownerId: hexFill('aa'), signature: hexFill('11') });
    // onChainReader has nothing registered — NOT_FOUND
    const result = await harness.service.submitOrder(input);
    expect(result).toMatchObject({ ok: false, code: 'NOT_ON_CHAIN' });
  });

  it('rejects when the on-chain commitment differs from the disclosed one (forged disclosure)', async () => {
    const input = buildInput({ id: hexFill('01'), side: 'BUY', price: 100n, amount: 10n, ownerId: hexFill('aa'), signature: hexFill('11') });
    harness.onChainReader.register(input.id, { state: 'OPEN', commitment: hexFill('ff') }); // different commitment on-chain
    const result = await harness.service.submitOrder(input);
    expect(result).toMatchObject({ ok: false, code: 'COMMITMENT_MISMATCH' });
  });

  it('rejects when the on-chain order is not OPEN', async () => {
    const input = buildInput({ id: hexFill('01'), side: 'BUY', price: 100n, amount: 10n, ownerId: hexFill('aa'), signature: hexFill('11') });
    harness.onChainReader.register(input.id, { state: 'CANCELLED', commitment: input.commitment });
    const result = await harness.service.submitOrder(input);
    expect(result).toMatchObject({ ok: false, code: 'NOT_OPEN_ON_CHAIN' });
  });

  it('rejects an already-expired order', async () => {
    const input = buildInput({ id: hexFill('01'), side: 'BUY', price: 100n, amount: 10n, ownerId: hexFill('aa'), signature: hexFill('11'), expiresAt: 1n });
    harness.onChainReader.register(input.id, { state: 'OPEN', commitment: input.commitment });
    const result = await harness.service.submitOrder(input);
    expect(result).toMatchObject({ ok: false, code: 'EXPIRED' });
  });

  it('matches two crossing orders from different owners, claims them atomically, and calls onMatch exactly once', async () => {
    const sell = buildInput({ id: hexFill('01'), side: 'SELL', price: 90n, amount: 10n, ownerId: hexFill('55'), signature: hexFill('11') });
    const buy = buildInput({ id: hexFill('02'), side: 'BUY', price: 100n, amount: 10n, ownerId: hexFill('66'), signature: hexFill('22') });
    harness.onChainReader.register(sell.id, { state: 'OPEN', commitment: sell.commitment });
    harness.onChainReader.register(buy.id, { state: 'OPEN', commitment: buy.commitment });

    await harness.service.submitOrder(sell);
    const result = await harness.service.submitOrder(buy);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.match).not.toBeNull();
      expect(result.match?.buyOrderId).toBe(buy.id);
      expect(result.match?.sellOrderId).toBe(sell.id);
    }
    expect(harness.orderRepo.findById(sell.id)?.status).toBe('MATCHED');
    expect(harness.orderRepo.findById(buy.id)?.status).toBe('MATCHED');
    // Matched orders leave the live matching book.
    expect(harness.orderBook.has(sell.id)).toBe(false);
    expect(harness.orderBook.has(buy.id)).toBe(false);
    expect(harness.onMatch).toHaveBeenCalledTimes(1);
    expect(harness.events.map(([t]) => t)).toEqual(['order.created', 'order.created', 'order.matched']);
  });

  it('retires the asset bootstrap price the moment it gets a real match', async () => {
    harness.bootstrapPriceRepo.set(ASSET, 1_000n, Date.now());
    expect(harness.bootstrapPriceRepo.get(ASSET)).toBe(1_000n);

    const sell = buildInput({ id: hexFill('03'), side: 'SELL', price: 90n, amount: 10n, ownerId: hexFill('55'), signature: hexFill('11') });
    const buy = buildInput({ id: hexFill('04'), side: 'BUY', price: 100n, amount: 10n, ownerId: hexFill('66'), signature: hexFill('22') });
    harness.onChainReader.register(sell.id, { state: 'OPEN', commitment: sell.commitment });
    harness.onChainReader.register(buy.id, { state: 'OPEN', commitment: buy.commitment });

    await harness.service.submitOrder(sell);
    await harness.service.submitOrder(buy);

    expect(harness.bootstrapPriceRepo.get(ASSET)).toBeNull();
  });

  it('does not match orders from the same owner (self-trade prevention)', async () => {
    const sell = buildInput({ id: hexFill('01'), side: 'SELL', price: 90n, amount: 10n, ownerId: hexFill('77'), signature: hexFill('11') });
    const buy = buildInput({ id: hexFill('02'), side: 'BUY', price: 100n, amount: 10n, ownerId: hexFill('77'), signature: hexFill('22') });
    harness.onChainReader.register(sell.id, { state: 'OPEN', commitment: sell.commitment });
    harness.onChainReader.register(buy.id, { state: 'OPEN', commitment: buy.commitment });

    await harness.service.submitOrder(sell);
    const result = await harness.service.submitOrder(buy);
    expect(result.ok && result.match).toBeNull();
    expect(harness.onMatch).not.toHaveBeenCalled();
  });

  it('does not match orders with mismatched amounts', async () => {
    const sell = buildInput({ id: hexFill('01'), side: 'SELL', price: 90n, amount: 5n, ownerId: hexFill('55'), signature: hexFill('11') });
    const buy = buildInput({ id: hexFill('02'), side: 'BUY', price: 100n, amount: 10n, ownerId: hexFill('66'), signature: hexFill('22') });
    harness.onChainReader.register(sell.id, { state: 'OPEN', commitment: sell.commitment });
    harness.onChainReader.register(buy.id, { state: 'OPEN', commitment: buy.commitment });

    await harness.service.submitOrder(sell);
    const result = await harness.service.submitOrder(buy);
    expect(result.ok && result.match).toBeNull();
  });

  it('does not match orders on different assets', async () => {
    const otherAsset = hexFill('bb');
    const sell = buildInput({ id: hexFill('01'), side: 'SELL', price: 90n, amount: 10n, ownerId: hexFill('55'), signature: hexFill('11'), asset: otherAsset });
    const buy = buildInput({ id: hexFill('02'), side: 'BUY', price: 100n, amount: 10n, ownerId: hexFill('66'), signature: hexFill('22') });
    harness.onChainReader.register(sell.id, { state: 'OPEN', commitment: sell.commitment });
    harness.onChainReader.register(buy.id, { state: 'OPEN', commitment: buy.commitment });

    await harness.service.submitOrder(sell);
    const result = await harness.service.submitOrder(buy);
    expect(result.ok && result.match).toBeNull();
  });

  it('leaves the order OPEN (not lost) if the atomic claim loses a race (defensive — structurally prevented in practice by single-threaded synchronous execution, see OrderService.ts)', async () => {
    const sell = buildInput({ id: hexFill('01'), side: 'SELL', price: 90n, amount: 10n, ownerId: hexFill('55'), signature: hexFill('11') });
    const buy = buildInput({ id: hexFill('02'), side: 'BUY', price: 100n, amount: 10n, ownerId: hexFill('66'), signature: hexFill('22') });
    harness.onChainReader.register(sell.id, { state: 'OPEN', commitment: sell.commitment });
    harness.onChainReader.register(buy.id, { state: 'OPEN', commitment: buy.commitment });
    await harness.service.submitOrder(sell);

    // Simulate the claim transaction losing a race: the buy-side CAS
    // succeeds but the sell-side one fails (e.g. it was independently
    // claimed a moment earlier).
    const spy = vi.spyOn(harness.orderRepo, 'updateStatus').mockReturnValueOnce(true).mockReturnValueOnce(false);

    const result = await harness.service.submitOrder(buy);
    spy.mockRestore();

    expect(result.ok && result.match).toBeNull();
    expect(harness.orderRepo.findById(buy.id)?.status).toBe('OPEN');
  });
});

describe('OrderService.submitOrder PPM fallback', () => {
  // Verifies the flow required alongside self-trade prevention: skipping a
  // same-owner candidate must NOT leave the order simply resting OPEN if a
  // PPMService is configured — it must fall through to attemptFill() in the
  // same synchronous request, exactly like a genuinely empty book does.
  function makeHarnessWithPpm(pendingOutcome: PpmFillOutcome) {
    const db = openDatabase(':memory:');
    const orderRepo = new OrderRepository(db);
    const matchRepo = new MatchRepository(db);
    const orderBook = new OrderBook();
    const matchingEngine = new MatchingEngine(orderBook, new PriceTimePriorityStrategy());
    const onChainReader = new FakeOnChainReader();
    const events: Array<[string, unknown]> = [];
    const broadcaster: Broadcaster = { broadcast: (type, payload) => events.push([type, payload]) };
    const onMatch = vi.fn();
    const attemptFill = vi.fn(async () => pendingOutcome);
    const ppmService = { attemptFill, markReservationExecuted: vi.fn() } as unknown as PPMService;

    const service = new OrderService({
      db, orderRepo, matchRepo, orderBook, matchingEngine, onChainReader, broadcaster, logger, onMatch, ppmService,
    });

    return { db, orderRepo, matchRepo, orderBook, onChainReader, events, onMatch, attemptFill, service };
  }

  const pendingQuote: PpmFillOutcome = {
    pending: true,
    quoteId: hexFill('99'),
    assetKey: ASSET,
    side: 'BUY',
    price: 2n,
    amount: 10n,
    expiresAt: 9_999_999_999n,
  };

  it('same owner BUY + SELL: self-trade is skipped, no match, PPM is attempted immediately in the same request', async () => {
    const harness = makeHarnessWithPpm(pendingQuote);
    const sell = buildInput({ id: hexFill('01'), side: 'SELL', price: 2n, amount: 10n, ownerId: hexFill('aa'), signature: hexFill('11') });
    const buy = buildInput({ id: hexFill('02'), side: 'BUY', price: 2n, amount: 10n, ownerId: hexFill('aa'), signature: hexFill('22') });
    harness.onChainReader.register(sell.id, { state: 'OPEN', commitment: sell.commitment });
    harness.onChainReader.register(buy.id, { state: 'OPEN', commitment: buy.commitment });

    // The resting SELL lands in an empty book, so it triggers its own PPM
    // attempt too (call #1) — that's independent of self-trade prevention.
    await harness.service.submitOrder(sell);
    harness.attemptFill.mockClear();

    const result = await harness.service.submitOrder(buy);

    expect(result.ok && result.match).toBeNull();
    expect(harness.onMatch).not.toHaveBeenCalled(); // no user-to-user settlement path duplicated
    expect(harness.attemptFill).toHaveBeenCalledTimes(1);
    expect(harness.attemptFill).toHaveBeenCalledWith(expect.objectContaining({ id: buy.id, side: 'BUY' }));
    if (result.ok) {
      expect(result.pendingProtocolQuote).toMatchObject({ quoteId: pendingQuote.pending ? pendingQuote.quoteId : undefined });
    }
    expect(harness.events.map(([t]) => t)).toContain('order.ppm_quote_ready');
  });

  it('different owners: normal order-book match still wins, PPM is never consulted for the taker', async () => {
    const harness = makeHarnessWithPpm(pendingQuote);
    const sell = buildInput({ id: hexFill('01'), side: 'SELL', price: 2n, amount: 10n, ownerId: hexFill('55'), signature: hexFill('11') });
    const buy = buildInput({ id: hexFill('02'), side: 'BUY', price: 2n, amount: 10n, ownerId: hexFill('66'), signature: hexFill('22') });
    harness.onChainReader.register(sell.id, { state: 'OPEN', commitment: sell.commitment });
    harness.onChainReader.register(buy.id, { state: 'OPEN', commitment: buy.commitment });

    // The resting SELL still triggers its own PPM attempt (empty book) — same as above.
    await harness.service.submitOrder(sell);
    harness.attemptFill.mockClear();

    const result = await harness.service.submitOrder(buy);

    expect(result.ok && result.match).not.toBeNull();
    expect(harness.onMatch).toHaveBeenCalledTimes(1);
    expect(harness.attemptFill).not.toHaveBeenCalled();
  });

  it('no order-book match at all (empty book): PPM is attempted immediately, no delay/scheduler', async () => {
    const harness = makeHarnessWithPpm(pendingQuote);
    const buy = buildInput({ id: hexFill('01'), side: 'BUY', price: 2n, amount: 10n, ownerId: hexFill('aa'), signature: hexFill('11') });
    harness.onChainReader.register(buy.id, { state: 'OPEN', commitment: buy.commitment });

    const result = await harness.service.submitOrder(buy);

    expect(result.ok && result.match).toBeNull();
    expect(harness.attemptFill).toHaveBeenCalledTimes(1);
    if (result.ok) {
      expect(result.pendingProtocolQuote).not.toBeNull();
    }
  });

  it('PPM declines (no liquidity): order simply rests OPEN, same as no PPM configured', async () => {
    const harness = makeHarnessWithPpm({ pending: false, reason: 'Protocol liquidity unavailable.' });
    const buy = buildInput({ id: hexFill('01'), side: 'BUY', price: 2n, amount: 10n, ownerId: hexFill('aa'), signature: hexFill('11') });
    harness.onChainReader.register(buy.id, { state: 'OPEN', commitment: buy.commitment });

    const result = await harness.service.submitOrder(buy);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.match).toBeNull();
      expect(result.pendingProtocolQuote).toBeNull();
      expect(result.order.status).toBe('OPEN');
    }
    expect(harness.orderBook.has(buy.id)).toBe(true);
  });
});

describe('OrderService.cancelOrder', () => {
  let harness: ReturnType<typeof makeHarness>;

  beforeEach(() => {
    harness = makeHarness();
  });

  it('cancels an OPEN order, removing it from the book and broadcasting order.cancelled', async () => {
    const input = buildInput({ id: hexFill('01'), side: 'BUY', price: 100n, amount: 10n, ownerId: hexFill('aa'), signature: hexFill('11') });
    harness.onChainReader.register(input.id, { state: 'OPEN', commitment: input.commitment });
    await harness.service.submitOrder(input);

    const result = harness.service.cancelOrder(input.id);
    expect(result).toMatchObject({ ok: true });
    expect(harness.orderRepo.findById(input.id)?.status).toBe('CANCELLED');
    expect(harness.orderBook.has(input.id)).toBe(false);
    expect(harness.events.at(-1)).toEqual(['order.cancelled', expect.objectContaining({ status: 'CANCELLED' })]);
  });

  it('returns NOT_FOUND for an unknown order id', () => {
    const result = harness.service.cancelOrder(hexFill('99'));
    expect(result).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });

  it('refuses to cancel a MATCHED order', async () => {
    const sell = buildInput({ id: hexFill('01'), side: 'SELL', price: 90n, amount: 10n, ownerId: hexFill('55'), signature: hexFill('11') });
    const buy = buildInput({ id: hexFill('02'), side: 'BUY', price: 100n, amount: 10n, ownerId: hexFill('66'), signature: hexFill('22') });
    harness.onChainReader.register(sell.id, { state: 'OPEN', commitment: sell.commitment });
    harness.onChainReader.register(buy.id, { state: 'OPEN', commitment: buy.commitment });
    await harness.service.submitOrder(sell);
    await harness.service.submitOrder(buy);

    const result = harness.service.cancelOrder(sell.id);
    expect(result).toMatchObject({ ok: false, code: 'NOT_CANCELLABLE' });
  });

  it('refuses to cancel an already-CANCELLED order', async () => {
    const input = buildInput({ id: hexFill('01'), side: 'BUY', price: 100n, amount: 10n, ownerId: hexFill('aa'), signature: hexFill('11') });
    harness.onChainReader.register(input.id, { state: 'OPEN', commitment: input.commitment });
    await harness.service.submitOrder(input);
    harness.service.cancelOrder(input.id);
    const result = harness.service.cancelOrder(input.id);
    expect(result).toMatchObject({ ok: false, code: 'NOT_CANCELLABLE' });
  });

  it('returns NOT_CANCELLABLE if the CAS update loses a race after the OPEN check passed (defensive)', async () => {
    const input = buildInput({ id: hexFill('01'), side: 'BUY', price: 100n, amount: 10n, ownerId: hexFill('aa'), signature: hexFill('11') });
    harness.onChainReader.register(input.id, { state: 'OPEN', commitment: input.commitment });
    await harness.service.submitOrder(input);

    const spy = vi.spyOn(harness.orderRepo, 'updateStatus').mockReturnValueOnce(false);
    const result = harness.service.cancelOrder(input.id);
    spy.mockRestore();

    expect(result).toMatchObject({ ok: false, code: 'NOT_CANCELLABLE' });
  });
});

describe('OrderService expiry materialization', () => {
  it('re-reads the authoritative row if the EXPIRED transition loses a race (defensive)', async () => {
    let now = 0;
    const db = openDatabase(':memory:');
    const orderRepo = new OrderRepository(db);
    const matchRepo = new MatchRepository(db);
    const orderBook = new OrderBook();
    const matchingEngine = new MatchingEngine(orderBook, new PriceTimePriorityStrategy());
    const onChainReader = new FakeOnChainReader();
    const broadcaster: Broadcaster = { broadcast: () => {} };
    const service = new OrderService({
      db, orderRepo, matchRepo, orderBook, matchingEngine, onChainReader, broadcaster, logger,
      onMatch: () => {},
      now: () => now,
    });

    const input = buildInput({ id: hexFill('01'), side: 'BUY', price: 100n, amount: 10n, ownerId: hexFill('aa'), signature: hexFill('11'), expiresAt: 1n });
    onChainReader.register(input.id, { state: 'OPEN', commitment: input.commitment });
    await service.submitOrder(input);
    now = 2_000; // past expiresAt=1n

    // Simulate someone else winning the race (e.g. a concurrent cancel) —
    // the CAS to EXPIRED fails, so getOrder should fall back to re-reading
    // the now-authoritative row rather than trusting its stale in-memory copy.
    orderRepo.updateStatus(input.id, 'CANCELLED', ['OPEN']);
    const spy = vi.spyOn(orderRepo, 'updateStatus').mockReturnValueOnce(false);

    const found = service.getOrder(input.id);
    spy.mockRestore();

    expect(found?.status).toBe('CANCELLED');
  });

  it('getOrder lazily transitions an OPEN-but-expired order to EXPIRED and evicts it from the book', async () => {
    let now = 0; // ms — must be < expiresAt(2n) seconds at submission time or submitOrder itself rejects as EXPIRED
    const db = openDatabase(':memory:');
    const orderRepo = new OrderRepository(db);
    const matchRepo = new MatchRepository(db);
    const orderBook = new OrderBook();
    const matchingEngine = new MatchingEngine(orderBook, new PriceTimePriorityStrategy());
    const onChainReader = new FakeOnChainReader();
    const events: Array<[string, unknown]> = [];
    const broadcaster: Broadcaster = { broadcast: (type, payload) => events.push([type, payload]) };
    const service = new OrderService({
      db, orderRepo, matchRepo, orderBook, matchingEngine, onChainReader, broadcaster, logger,
      onMatch: () => {},
      now: () => now,
    });

    const input = buildInput({ id: hexFill('01'), side: 'BUY', price: 100n, amount: 10n, ownerId: hexFill('aa'), signature: hexFill('11'), expiresAt: 2n });
    onChainReader.register(input.id, { state: 'OPEN', commitment: input.commitment });
    await service.submitOrder(input);
    expect(orderBook.has(input.id)).toBe(true);

    now = 3_000; // 3 seconds — past expiresAt=2
    const found = service.getOrder(input.id);
    expect(found?.status).toBe('EXPIRED');
    expect(orderBook.has(input.id)).toBe(false);
    expect(events.at(-1)?.[0]).toBe('order.expired');
  });

  it('listOpen excludes orders that have lazily expired', async () => {
    let now = 0;
    const db = openDatabase(':memory:');
    const orderRepo = new OrderRepository(db);
    const matchRepo = new MatchRepository(db);
    const orderBook = new OrderBook();
    const matchingEngine = new MatchingEngine(orderBook, new PriceTimePriorityStrategy());
    const onChainReader = new FakeOnChainReader();
    const broadcaster: Broadcaster = { broadcast: () => {} };
    const service = new OrderService({
      db, orderRepo, matchRepo, orderBook, matchingEngine, onChainReader, broadcaster, logger,
      onMatch: () => {},
      now: () => now,
    });

    const input = buildInput({ id: hexFill('01'), side: 'BUY', price: 100n, amount: 10n, ownerId: hexFill('aa'), signature: hexFill('11'), expiresAt: 1n });
    onChainReader.register(input.id, { state: 'OPEN', commitment: input.commitment });
    await service.submitOrder(input);

    now = 2_000;
    expect(service.listOpen()).toEqual([]);
  });
});

describe('OrderService market data reads', () => {
  let harness: ReturnType<typeof makeHarness>;

  beforeEach(() => {
    harness = makeHarness();
  });

  it('getOrderBookSnapshot aggregates resting OPEN orders for the queried asset only', async () => {
    const other = hexFill('ff');
    const buy1 = buildInput({ id: hexFill('01'), side: 'BUY', price: 900n, amount: 10n, ownerId: hexFill('aa'), signature: hexFill('11') });
    const buy2 = buildInput({ id: hexFill('02'), side: 'BUY', price: 900n, amount: 5n, ownerId: hexFill('bb'), signature: hexFill('22') });
    const sell = buildInput({ id: hexFill('03'), side: 'SELL', price: 1_200n, amount: 20n, ownerId: hexFill('cc'), signature: hexFill('33') });
    const otherAsset = buildInput({ id: hexFill('04'), side: 'BUY', price: 500n, amount: 1n, ownerId: hexFill('dd'), signature: hexFill('44'), asset: other });
    for (const input of [buy1, buy2, sell, otherAsset]) {
      harness.onChainReader.register(input.id, { state: 'OPEN', commitment: input.commitment });
      await harness.service.submitOrder(input);
    }

    const snapshot = harness.service.getOrderBookSnapshot(ASSET);
    expect(snapshot.bids).toEqual([{ price: 900n, amount: 15n, orderCount: 2 }]);
    expect(snapshot.asks).toEqual([{ price: 1_200n, amount: 20n, orderCount: 1 }]);
  });

  it('listRecentTrades returns matches for the queried asset, newest first', async () => {
    const buy1 = buildInput({ id: hexFill('01'), side: 'BUY', price: 1_000n, amount: 10n, ownerId: hexFill('aa'), signature: hexFill('11') });
    const sell1 = buildInput({ id: hexFill('02'), side: 'SELL', price: 900n, amount: 10n, ownerId: hexFill('bb'), signature: hexFill('22') });
    for (const input of [buy1, sell1]) {
      harness.onChainReader.register(input.id, { state: 'OPEN', commitment: input.commitment });
    }
    await harness.service.submitOrder(buy1);
    const { match } = await harness.service.submitOrder(sell1) as { match: { id: string } | null };

    const trades = harness.service.listRecentTrades(ASSET, 10);
    expect(trades).toHaveLength(1);
    expect(trades[0]?.id).toBe(match?.id);
    expect(trades[0]?.price).toBe(900n); // resting (sell) order's price
    expect(trades[0]?.amount).toBe(10n);
  });

  // Matches are inserted directly via matchRepo (rather than driven through
  // the full submitOrder matching flow) so `matchedAt` can be pinned exactly
  // — MatchingEngine.onOrderArrived stamps matches with the real wall-clock
  // Date.now(), not OrderService's injectable `now`, so submitOrder can't
  // produce a deterministic matchedAt under a mocked clock.
  it('getMarketStats computes last/open/high/low/volume/changePct over the window from persisted matches', () => {
    const now = 3_000;
    const db = openDatabase(':memory:');
    const orderRepo = new OrderRepository(db);
    const matchRepo = new MatchRepository(db);
    const orderBook = new OrderBook();
    const matchingEngine = new MatchingEngine(orderBook, new PriceTimePriorityStrategy());
    const onChainReader = new FakeOnChainReader();
    const broadcaster: Broadcaster = { broadcast: () => {} };
    const service = new OrderService({
      db, orderRepo, matchRepo, orderBook, matchingEngine, onChainReader, broadcaster, logger,
      onMatch: () => {},
      now: () => now,
    });

    orderRepo.insert({
      id: hexFill('01'), asset: ASSET, side: 'BUY', price: 1_000n, amount: 10n,
      commitment: hexFill('c1'), ownerId: hexFill('aa'), signature: hexFill('11'),
      status: 'FILLED', createdAt: 0, expiresAt: 9_999_999_999n,
    });
    orderRepo.insert({
      id: hexFill('02'), asset: ASSET, side: 'SELL', price: 1_000n, amount: 10n,
      commitment: hexFill('c2'), ownerId: hexFill('bb'), signature: hexFill('22'),
      status: 'FILLED', createdAt: 0, expiresAt: 9_999_999_999n,
    });
    orderRepo.insert({
      id: hexFill('03'), asset: ASSET, side: 'BUY', price: 1_100n, amount: 5n,
      commitment: hexFill('c3'), ownerId: hexFill('cc'), signature: hexFill('33'),
      status: 'FILLED', createdAt: 1_000, expiresAt: 9_999_999_999n,
    });
    orderRepo.insert({
      id: hexFill('04'), asset: ASSET, side: 'SELL', price: 1_100n, amount: 5n,
      commitment: hexFill('c4'), ownerId: hexFill('dd'), signature: hexFill('44'),
      status: 'FILLED', createdAt: 1_000, expiresAt: 9_999_999_999n,
    });
    matchRepo.insert({ id: 'm1', buyOrderId: hexFill('01'), sellOrderId: hexFill('02'), asset: ASSET, price: 1_000n, amount: 10n, matchedAt: 1_000 });
    matchRepo.insert({ id: 'm2', buyOrderId: hexFill('03'), sellOrderId: hexFill('04'), asset: ASSET, price: 1_100n, amount: 5n, matchedAt: 2_000 });

    const stats = service.getMarketStats(ASSET, 10_000);
    expect(stats.tradeCount).toBe(2);
    expect(stats.openPrice).toBe(1_000n);
    expect(stats.lastPrice).toBe(1_100n);
    expect(stats.high).toBe(1_100n);
    expect(stats.low).toBe(1_000n);
    expect(stats.volumeBase).toBe(15n);
    expect(stats.changePct).toBeCloseTo(10, 5);
  });

  it('getMarketStats excludes trades outside the window', () => {
    harness.orderRepo.insert({
      id: hexFill('01'), asset: ASSET, side: 'BUY', price: 1_000n, amount: 10n,
      commitment: hexFill('c1'), ownerId: hexFill('aa'), signature: hexFill('11'),
      status: 'FILLED', createdAt: 0, expiresAt: 9_999_999_999n,
    });
    harness.orderRepo.insert({
      id: hexFill('02'), asset: ASSET, side: 'SELL', price: 1_000n, amount: 10n,
      commitment: hexFill('c2'), ownerId: hexFill('bb'), signature: hexFill('22'),
      status: 'FILLED', createdAt: 0, expiresAt: 9_999_999_999n,
    });
    harness.matchRepo.insert({ id: 'm1', buyOrderId: hexFill('01'), sellOrderId: hexFill('02'), asset: ASSET, price: 1_000n, amount: 10n, matchedAt: 0 });

    // The service's `now` defaults to Date.now(), which is always far past a
    // trade pinned at matchedAt=0 relative to a narrow 10s window.
    const stats = harness.service.getMarketStats(ASSET, 10_000);
    expect(stats).toEqual({ asset: ASSET, lastPrice: null, openPrice: null, high: null, low: null, volumeBase: 0n, tradeCount: 0, changePct: null });
  });
});
