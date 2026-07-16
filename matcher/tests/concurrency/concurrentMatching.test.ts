import { describe, expect, it } from 'vitest';

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

function buildInput(id: string, side: 'BUY' | 'SELL', price: bigint, amount: bigint, ownerId: string, signature: string): CreateOrderInput {
  const expiresAt = 9_999_999_999n;
  const details = toOrderDetailsValue({ asset: ASSET, side, price, amount, ownerId, expiresAt });
  const commitment = computeCommitmentHex(details, signature);
  return { id, asset: ASSET, side, price, amount, commitment, ownerId, signature, expiresAt, payoutAddress: null };
}

/** Delays every on-chain read by one macrotask, so two concurrent submitOrder() calls genuinely interleave at the `await` point rather than running back-to-back. */
class DelayedOnChainReader implements OnChainOrderReader {
  constructor(private readonly registry: Map<string, OnChainOrderRecord>) {}
  async getOrder(orderId: string): Promise<OnChainOrderRecord> {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return this.registry.get(orderId) ?? { state: 'NOT_FOUND', commitment: null };
  }
}

describe('concurrent order submission', () => {
  it('when two crossing BUY orders race for the same resting SELL order, exactly one claims it — never both', async () => {
    const db = openDatabase(':memory:');
    const orderRepo = new OrderRepository(db);
    const matchRepo = new MatchRepository(db);
    const orderBook = new OrderBook();
    const matchingEngine = new MatchingEngine(orderBook, new PriceTimePriorityStrategy());
    const registry = new Map<string, OnChainOrderRecord>();
    const onChainReader = new DelayedOnChainReader(registry);
    const matchesSeen: unknown[] = [];
    const broadcaster: Broadcaster = {
      broadcast: (type, payload) => {
        if (type === 'order.matched') matchesSeen.push(payload);
      },
    };
    const onMatchCalls: unknown[] = [];
    const orderService = new OrderService({
      db, orderRepo, matchRepo, orderBook, matchingEngine, onChainReader, broadcaster, logger,
      onMatch: (match) => onMatchCalls.push(match),
    });

    const sell = buildInput(hexFill('01'), 'SELL', 90n, 10n, hexFill('55'), hexFill('11'));
    registry.set(sell.id, { state: 'OPEN', commitment: sell.commitment });
    await orderService.submitOrder(sell);

    const buyA = buildInput(hexFill('02'), 'BUY', 100n, 10n, hexFill('66'), hexFill('22'));
    const buyB = buildInput(hexFill('03'), 'BUY', 100n, 10n, hexFill('77'), hexFill('33'));
    registry.set(buyA.id, { state: 'OPEN', commitment: buyA.commitment });
    registry.set(buyB.id, { state: 'OPEN', commitment: buyB.commitment });

    const [resultA, resultB] = await Promise.all([orderService.submitOrder(buyA), orderService.submitOrder(buyB)]);

    const matched = [resultA, resultB].filter((r) => r.ok && r.match !== null);
    const unmatched = [resultA, resultB].filter((r) => r.ok && r.match === null);

    expect(matched).toHaveLength(1);
    expect(unmatched).toHaveLength(1);
    expect(onMatchCalls).toHaveLength(1);
    expect(matchesSeen).toHaveLength(1);

    // The sell order is claimed by exactly one buyer; the other stays OPEN, free to match something else later.
    expect(orderRepo.findById(sell.id)?.status).toBe('MATCHED');
    const winner = matched[0]!.ok ? matched[0].order.id : null;
    const loser = winner === buyA.id ? buyB.id : buyA.id;
    expect(orderRepo.findById(winner!)?.status).toBe('MATCHED');
    expect(orderRepo.findById(loser)?.status).toBe('OPEN');
    expect(orderBook.has(loser)).toBe(true);
  });

  it('submitting the same order id concurrently twice results in exactly one acceptance', async () => {
    const db = openDatabase(':memory:');
    const orderRepo = new OrderRepository(db);
    const matchRepo = new MatchRepository(db);
    const orderBook = new OrderBook();
    const matchingEngine = new MatchingEngine(orderBook, new PriceTimePriorityStrategy());
    const registry = new Map<string, OnChainOrderRecord>();
    const onChainReader = new DelayedOnChainReader(registry);
    const broadcaster: Broadcaster = { broadcast: () => {} };
    const orderService = new OrderService({
      db, orderRepo, matchRepo, orderBook, matchingEngine, onChainReader, broadcaster, logger,
      onMatch: () => {},
    });

    const order = buildInput(hexFill('01'), 'BUY', 100n, 10n, hexFill('55'), hexFill('11'));
    registry.set(order.id, { state: 'OPEN', commitment: order.commitment });

    const [r1, r2] = await Promise.all([orderService.submitOrder(order), orderService.submitOrder(order)]);
    const outcomes = [r1, r2].map((r) => (r.ok ? 'ok' : r.code));
    expect(outcomes.filter((o) => o === 'ok')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'DUPLICATE')).toHaveLength(1);
  });
});
