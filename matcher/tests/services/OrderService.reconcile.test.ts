import { describe, expect, it } from 'vitest';

import { MatchRepository } from '../../src/db/repositories/MatchRepository.js';
import { OrderRepository } from '../../src/db/repositories/OrderRepository.js';
import { ReservationRepository } from '../../src/db/repositories/ReservationRepository.js';
import { openDatabase } from '../../src/db/sqlite.js';
import { MatchingEngine } from '../../src/matcher/MatchingEngine.js';
import { PriceTimePriorityStrategy } from '../../src/matcher/MatchingStrategy.js';
import { OrderBook } from '../../src/orderbook/OrderBook.js';
import type { PPMService } from '../../src/ppm/PPMService.js';
import type { OnChainReservationReader, OnChainReservationState } from '../../src/ppm/TreasuryClient.js';
import { OrderService } from '../../src/services/OrderService.js';
import type { OnChainOrderReader, OnChainOrderRecord } from '../../src/settlement/SettlementClient.js';
import type { Order } from '../../src/types/Order.js';
import { createLogger } from '../../src/utils/logger.js';
import type { Broadcaster, MatcherEventType } from '../../src/websocket/SocketServer.js';

const logger = createLogger('test', { level: 'silent' });

function hexFill(byte: string): string {
  return byte.repeat(32);
}

const ASSET = hexFill('aa');
const ON_CHAIN_ASSET_KEY = hexFill('55');

function openOrder(id: string): Order {
  return {
    id,
    asset: ASSET,
    side: 'BUY',
    price: 1_100n,
    amount: 100n,
    commitment: hexFill('cc'),
    ownerId: hexFill('bb'),
    signature: hexFill('dd'),
    status: 'OPEN',
    createdAt: Date.now(),
    expiresAt: 9_999_999_999n,
    payoutAddress: hexFill('99'),
  };
}

/**
 * Minimal OrderService harness whose only fakes are the on-chain seams —
 * the ORDER registry and the RESERVATION registry are both directly settable
 * so each test can pit "what the chain says" against "what the local DB
 * still claims". This is exactly the surface reconciliation exists to
 * resolve, and it always trusts the chain.
 */
function buildHarness() {
  const db = openDatabase(':memory:');
  const orderRepo = new OrderRepository(db);
  const matchRepo = new MatchRepository(db);
  const reservationRepo = new ReservationRepository(db);
  const orderBook = new OrderBook();
  const matchingEngine = new MatchingEngine(orderBook, new PriceTimePriorityStrategy());

  const onChainOrders = new Map<string, OnChainOrderRecord>();
  const onChainReader: OnChainOrderReader = {
    async getOrder(id) {
      return onChainOrders.get(id) ?? { state: 'NOT_FOUND', commitment: null };
    },
  };
  const onChainReservations = new Map<string, OnChainReservationState>();
  const reservationReader: OnChainReservationReader = {
    async getReservationState(quoteId) {
      return onChainReservations.get(quoteId) ?? 'NOT_FOUND';
    },
  };

  const events: Array<[MatcherEventType, unknown]> = [];
  const broadcaster: Broadcaster = { broadcast: (type, payload) => events.push([type, payload]) };

  // Stub PPMService — reconciliation only ever calls markReservationExecuted.
  const ppmService = {
    markReservationExecuted: (quoteId: string) => {
      reservationRepo.updateState(quoteId, 'EXECUTED', ['OPEN']);
      return reservationRepo.findById(quoteId);
    },
  } as unknown as PPMService;

  const orderService = new OrderService({
    db, orderRepo, matchRepo, orderBook, matchingEngine, onChainReader, broadcaster, logger,
    onMatch: () => { throw new Error('no match expected'); },
    ppmService,
    reservationRepo,
    reservationReader,
  });

  /** Registers a locally-OPEN order plus an OPEN reservation pointing at it. */
  const seedPending = (orderId: string, quoteId: string): void => {
    const order = openOrder(orderId);
    orderRepo.insert(order);
    onChainOrders.set(orderId, { state: 'OPEN', commitment: order.commitment });
    const now = Date.now();
    reservationRepo.insert({
      quoteId, orderId, assetKey: ON_CHAIN_ASSET_KEY, amount: 100n, price: 1_010n,
      expiresAt: 9_999_999_999n, state: 'OPEN', createdAt: now, updatedAt: now,
    });
    onChainReservations.set(quoteId, 'OPEN');
  };

  return { orderRepo, reservationRepo, onChainOrders, onChainReservations, events, orderService, seedPending };
}

describe('OrderService lazy reconciliation (on-chain state wins)', () => {
  it('materializes OPEN -> FILLED when the chain shows the ORDER filled', async () => {
    const { orderRepo, reservationRepo, onChainOrders, events, orderService, seedPending } = buildHarness();
    seedPending(hexFill('01'), hexFill('a1'));

    // The user's wallet settled: order is FILLED on-chain.
    onChainOrders.set(hexFill('01'), { state: 'FILLED', commitment: hexFill('cc') });

    const result = await orderService.getOrderReconciled(hexFill('01'));
    expect(result?.status).toBe('FILLED');
    expect(orderRepo.findById(hexFill('01'))?.status).toBe('FILLED');
    expect(reservationRepo.findById(hexFill('a1'))?.state).toBe('EXECUTED');
    const filled = events.find(([t]) => t === 'order.filled')?.[1] as { matchedWith: string };
    expect(filled.matchedWith).toBe('protocol');
  });

  it('materializes via the RESERVATION reader even if the order registry read lags (reservation EXECUTED)', async () => {
    const { orderRepo, onChainReservations, orderService, seedPending } = buildHarness();
    seedPending(hexFill('02'), hexFill('a2'));

    // Reservation is EXECUTED on-chain but the order-state read hasn't caught
    // up yet — reconciliation still fires off the reservation signal.
    onChainReservations.set(hexFill('a2'), 'EXECUTED');

    const result = await orderService.getOrderReconciled(hexFill('02'));
    expect(result?.status).toBe('FILLED');
    expect(orderRepo.findById(hexFill('02'))?.status).toBe('FILLED');
  });

  it('does NOT materialize while the chain still shows the order OPEN — a local "claim" is never trusted over the chain', async () => {
    const { orderRepo, reservationRepo, events, orderService, seedPending } = buildHarness();
    seedPending(hexFill('03'), hexFill('a3'));

    // Chain says OPEN, reservation OPEN — nothing landed.
    const result = await orderService.getOrderReconciled(hexFill('03'));
    expect(result?.status).toBe('OPEN');
    expect(orderRepo.findById(hexFill('03'))?.status).toBe('OPEN');
    expect(reservationRepo.findById(hexFill('a3'))?.state).toBe('OPEN');
    expect(events.filter(([t]) => t === 'order.filled')).toHaveLength(0);
  });

  it('is a no-op for an order with no pending reservation', async () => {
    const { orderRepo, orderService, onChainOrders } = buildHarness();
    const order = openOrder(hexFill('04'));
    orderRepo.insert(order);
    onChainOrders.set(hexFill('04'), { state: 'FILLED', commitment: order.commitment });

    // Even though the chain shows FILLED, with no reservation there is nothing
    // to reconcile as a protocol fill — the read returns the order untouched.
    const result = await orderService.getOrderReconciled(hexFill('04'));
    expect(result?.status).toBe('OPEN');
  });

  it('is idempotent: reconciling twice emits order.filled once', async () => {
    const { onChainOrders, events, orderService, seedPending } = buildHarness();
    seedPending(hexFill('05'), hexFill('a5'));
    onChainOrders.set(hexFill('05'), { state: 'FILLED', commitment: hexFill('cc') });

    await orderService.getOrderReconciled(hexFill('05'));
    await orderService.getOrderReconciled(hexFill('05'));

    expect(events.filter(([t]) => t === 'order.filled')).toHaveLength(1);
  });

  it('reconcileAllPendingProtocolFills materializes every landed reservation and returns the count', async () => {
    const { onChainOrders, orderRepo, orderService, seedPending } = buildHarness();
    seedPending(hexFill('06'), hexFill('a6'));
    seedPending(hexFill('07'), hexFill('a7'));
    // Only the first has settled on-chain.
    onChainOrders.set(hexFill('06'), { state: 'FILLED', commitment: hexFill('cc') });

    const materialized = await orderService.reconcileAllPendingProtocolFills();
    expect(materialized).toBe(1);
    expect(orderRepo.findById(hexFill('06'))?.status).toBe('FILLED');
    expect(orderRepo.findById(hexFill('07'))?.status).toBe('OPEN');
  });
});
