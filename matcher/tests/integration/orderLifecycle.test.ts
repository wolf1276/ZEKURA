import { describe, expect, it } from 'vitest';

import { MatchRepository } from '../../src/db/repositories/MatchRepository.js';
import { OrderRepository } from '../../src/db/repositories/OrderRepository.js';
import { openDatabase } from '../../src/db/sqlite.js';
import { MatchingEngine } from '../../src/matcher/MatchingEngine.js';
import { PriceTimePriorityStrategy } from '../../src/matcher/MatchingStrategy.js';
import { OrderBook } from '../../src/orderbook/OrderBook.js';
import { OrderService } from '../../src/services/OrderService.js';
import { SettlementService } from '../../src/services/SettlementService.js';
import { SettlementClient, type OnChainOrderReader, type OnChainOrderRecord, type SettleCircuitCaller } from '../../src/settlement/SettlementClient.js';
import { SettlementQueue } from '../../src/settlement/SettlementQueue.js';
import { computeCommitmentHex, toOrderDetailsValue } from '../../src/utils/orderDetailsCodec.js';
import { createLogger } from '../../src/utils/logger.js';
import type { Broadcaster, MatcherEventType } from '../../src/websocket/SocketServer.js';
import type { CreateOrderInput } from '../../src/utils/validation.js';

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
}

function buildInput(opts: DraftOpts): CreateOrderInput {
  const expiresAt = 9_999_999_999n;
  const details = toOrderDetailsValue({ asset: ASSET, side: opts.side, price: opts.price, amount: opts.amount, ownerId: opts.ownerId, expiresAt });
  const commitment = computeCommitmentHex(details, opts.signature);
  return { id: opts.id, asset: ASSET, side: opts.side, price: opts.price, amount: opts.amount, commitment, ownerId: opts.ownerId, signature: opts.signature, expiresAt, payoutAddress: null };
}

/**
 * Wires every real module together (no mocks below the chain boundary) —
 * only the two SDK-facing seams (SettleCircuitCaller, OnChainOrderReader)
 * are faked, exactly as src/index.ts would inject real ones. This is the
 * closest thing to an end-to-end test that doesn't require a live devnet.
 */
function buildSystem(settleCaller: SettleCircuitCaller) {
  const db = openDatabase(':memory:');
  const orderRepo = new OrderRepository(db);
  const matchRepo = new MatchRepository(db);
  const orderBook = new OrderBook();
  const matchingEngine = new MatchingEngine(orderBook, new PriceTimePriorityStrategy());

  const onChainRegistry = new Map<string, OnChainOrderRecord>();
  const onChainReader: OnChainOrderReader = {
    async getOrder(id) {
      return onChainRegistry.get(id) ?? { state: 'NOT_FOUND', commitment: null };
    },
  };

  const events: Array<[MatcherEventType, unknown]> = [];
  const broadcaster: Broadcaster = { broadcast: (type, payload) => events.push([type, payload]) };

  const settlementClient = new SettlementClient(settleCaller, onChainReader, logger);
  const queue = new SettlementQueue({ maxRetries: 2, retryDelayMs: 5 }, logger);

  // eslint-disable-next-line prefer-const -- assigned once, below; must stay `let` for the onMatch closure above to observe it
  let settlementService: SettlementService | undefined;
  const orderService = new OrderService({
    db, orderRepo, matchRepo, orderBook, matchingEngine, onChainReader, broadcaster, logger,
    onMatch: (match) => settlementService?.handleMatch(match),
  });
  settlementService = new SettlementService({ db, orderRepo, matchRepo, settlementClient, queue, broadcaster, logger });

  return { orderRepo, matchRepo, orderBook, onChainRegistry, events, orderService, settlementService, queue };
}

describe('order lifecycle integration', () => {
  it('createOrder (simulated) -> submit -> match -> settle -> filled, with events in order', async () => {
    let settled = false;
    const settleCaller: SettleCircuitCaller = {
      async settle(buyIdBytes, sellIdBytes) {
        settled = true;
        const buyId = Buffer.from(buyIdBytes).toString('hex');
        const sellId = Buffer.from(sellIdBytes).toString('hex');
        const sys = current;
        sys.onChainRegistry.set(buyId, { ...sys.onChainRegistry.get(buyId)!, state: 'FILLED' });
        sys.onChainRegistry.set(sellId, { ...sys.onChainRegistry.get(sellId)!, state: 'FILLED' });
        return { public: { txId: 'chain-tx-1' } };
      },
    };
    const current = buildSystem(settleCaller);
    const { orderRepo, onChainRegistry, events, orderService, queue } = current;

    const sell = buildInput({ id: hexFill('01'), side: 'SELL', price: 90n, amount: 10n, ownerId: hexFill('55'), signature: hexFill('11') });
    const buy = buildInput({ id: hexFill('02'), side: 'BUY', price: 100n, amount: 10n, ownerId: hexFill('66'), signature: hexFill('22') });

    // Simulates the wallet's own on-chain createOrder() having already succeeded for both.
    onChainRegistry.set(sell.id, { state: 'OPEN', commitment: sell.commitment });
    onChainRegistry.set(buy.id, { state: 'OPEN', commitment: buy.commitment });

    const r1 = await orderService.submitOrder(sell);
    expect(r1.ok && r1.match).toBeNull();

    const r2 = await orderService.submitOrder(buy);
    expect(r2.ok).toBe(true);
    expect(r2.ok && r2.match).not.toBeNull();

    await vi_waitForQueueIdle(queue, r2.ok ? r2.match!.id : '');

    expect(settled).toBe(true);
    expect(orderRepo.findById(sell.id)?.status).toBe('FILLED');
    expect(orderRepo.findById(buy.id)?.status).toBe('FILLED');
    expect(events.map(([t]) => t)).toEqual(['order.created', 'order.created', 'order.matched', 'order.settling', 'order.filled']);
  });

  it('an order that never gets a matching counterparty stays OPEN indefinitely and can be cancelled', async () => {
    const settleCaller: SettleCircuitCaller = { async settle() { throw new Error('should not be called'); } };
    const { orderRepo, orderBook, onChainRegistry, orderService } = buildSystem(settleCaller);

    const order = buildInput({ id: hexFill('01'), side: 'BUY', price: 100n, amount: 10n, ownerId: hexFill('55'), signature: hexFill('11') });
    onChainRegistry.set(order.id, { state: 'OPEN', commitment: order.commitment });

    const result = await orderService.submitOrder(order);
    expect(result.ok && result.match).toBeNull();
    expect(orderBook.has(order.id)).toBe(true);

    const cancelled = orderService.cancelOrder(order.id);
    expect(cancelled.ok).toBe(true);
    expect(orderRepo.findById(order.id)?.status).toBe('CANCELLED');
    expect(orderBook.has(order.id)).toBe(false);
  });
});

async function vi_waitForQueueIdle(queue: SettlementQueue, key: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (queue.isInFlight(key) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
