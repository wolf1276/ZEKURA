import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const logger = createLogger('test', { level: 'silent' });

function hexFill(byte: string): string {
  return byte.repeat(32);
}

const ASSET = { isLeft: true, left: hexFill('aa'), right: hexFill('00') };

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
  });

  return { db, orderRepo, matchRepo, orderBook, onChainReader, events, onMatch, service };
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
    const otherAsset = { isLeft: true, left: hexFill('bb'), right: hexFill('00') };
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
