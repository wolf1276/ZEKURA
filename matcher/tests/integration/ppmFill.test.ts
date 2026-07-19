import { describe, expect, it } from 'vitest';

import { BootstrapPriceRepository } from '../../src/db/repositories/BootstrapPriceRepository.js';
import { MatchRepository } from '../../src/db/repositories/MatchRepository.js';
import { OrderRepository } from '../../src/db/repositories/OrderRepository.js';
import { ReservationRepository } from '../../src/db/repositories/ReservationRepository.js';
import { TreasuryRepository } from '../../src/db/repositories/TreasuryRepository.js';
import { openDatabase } from '../../src/db/sqlite.js';
import { MatchingEngine } from '../../src/matcher/MatchingEngine.js';
import { PriceTimePriorityStrategy } from '../../src/matcher/MatchingStrategy.js';
import { OrderBook } from '../../src/orderbook/OrderBook.js';
import { PPMService } from '../../src/ppm/PPMService.js';
import { PricingEngine, DEFAULT_PRICING_CONFIG } from '../../src/ppm/PricingEngine.js';
import {
  TreasuryClient,
  type OnChainReservationReader,
  type OnChainReservationState,
  type OnChainTreasuryReader,
  type PpmCircuitCaller,
  type TreasuryLiquidity,
} from '../../src/ppm/TreasuryClient.js';
import { MarketDataService } from '../../src/services/MarketDataService.js';
import { OrderService } from '../../src/services/OrderService.js';
import { createLogger } from '../../src/utils/logger.js';
import { computeCommitmentHex, toOrderDetailsValue } from '../../src/utils/orderDetailsCodec.js';
import type { CreateOrderInput } from '../../src/utils/validation.js';
import type { OnChainOrderReader, OnChainOrderRecord } from '../../src/settlement/SettlementClient.js';
import type { Broadcaster, MatcherEventType } from '../../src/websocket/SocketServer.js';

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
  payoutAddress?: string | null;
}

function buildInput(opts: DraftOpts): CreateOrderInput {
  const expiresAt = 9_999_999_999n;
  const details = toOrderDetailsValue({ asset: ASSET, side: opts.side, price: opts.price, amount: opts.amount, ownerId: opts.ownerId, expiresAt });
  const commitment = computeCommitmentHex(details, opts.signature);
  return {
    id: opts.id,
    asset: ASSET,
    side: opts.side,
    price: opts.price,
    amount: opts.amount,
    commitment,
    ownerId: opts.ownerId,
    signature: opts.signature,
    expiresAt,
    payoutAddress: opts.payoutAddress ?? null,
  };
}

/**
 * Wires OrderService + PPMService together for real (no mocks between them)
 * — only the on-chain seam (PpmCircuitCaller / OnChainTreasuryReader /
 * OnChainReservationReader / OnChainOrderReader) is faked, exactly as
 * src/index.ts injects real ones. `liquidity` controls what the fake
 * Treasury reports available (it reports the same for the traded asset and
 * for NIGHT, since a single reader backs both). `settleOnChain` simulates
 * the user's OWN wallet submitting settleWithProtocol — the Matcher never
 * does this itself anymore.
 */
function buildSystem(liquidity: TreasuryLiquidity, now: () => number = () => Date.now()) {
  const db = openDatabase(':memory:');
  const orderRepo = new OrderRepository(db);
  const matchRepo = new MatchRepository(db);
  const bootstrapPriceRepo = new BootstrapPriceRepository(db);
  const reservationRepo = new ReservationRepository(db);
  const treasuryRepo = new TreasuryRepository(db);
  const orderBook = new OrderBook();
  const matchingEngine = new MatchingEngine(orderBook, new PriceTimePriorityStrategy());

  const onChainRegistry = new Map<string, OnChainOrderRecord>();
  const onChainReader: OnChainOrderReader = {
    async getOrder(id) {
      return onChainRegistry.get(id) ?? { state: 'NOT_FOUND', commitment: null };
    },
  };

  const reservationRegistry = new Map<string, OnChainReservationState>();
  const reservationReader: OnChainReservationReader = {
    async getReservationState(quoteId) {
      return reservationRegistry.get(quoteId) ?? 'NOT_FOUND';
    },
  };

  const events: Array<[MatcherEventType, unknown]> = [];
  const broadcaster: Broadcaster = { broadcast: (type, payload) => events.push([type, payload]) };

  const ppmCaller: PpmCircuitCaller = {
    reserveLiquidity: async (quoteId) => {
      reservationRegistry.set(Buffer.from(quoteId).toString('hex'), 'OPEN');
      return { public: { txId: 'reserve-tx' } };
    },
    releaseLiquidity: async (quoteId) => {
      reservationRegistry.set(Buffer.from(quoteId).toString('hex'), 'RELEASED');
      return { public: { txId: 'release-tx' } };
    },
    releaseExpiredLiquidity: async (quoteId) => {
      reservationRegistry.set(Buffer.from(quoteId).toString('hex'), 'RELEASED');
      return { public: { txId: 'expire-tx' } };
    },
    // The Matcher no longer calls this — kept only so the interface is
    // satisfied; a test asserting it is never invoked would use a spy.
    settleWithProtocol: async () => ({ public: { txId: 'settle-tx' } }),
    depositTreasury: async () => ({ public: { txId: 'deposit-tx' } }),
    withdrawTreasury: async () => ({ public: { txId: 'withdraw-tx' } }),
  };
  const treasuryReader: OnChainTreasuryReader = { getLiquidity: async () => liquidity };
  const treasuryClient = new TreasuryClient(ppmCaller, treasuryReader, logger);

  // eslint-disable-next-line prefer-const -- assigned once, below; must stay `let` for the closures above to observe it
  let orderServiceRef: OrderService | undefined;
  const marketDataService = new MarketDataService({
    getOrderBookSnapshot: (asset) => orderServiceRef!.getOrderBookSnapshot(asset),
    getMarketStats: (asset, windowMs) => orderServiceRef!.getMarketStats(asset, windowMs),
    treasuryClient,
    bootstrapPriceRepo,
  });
  const pricingEngine = new PricingEngine({ ...DEFAULT_PRICING_CONFIG, baseSpreadBps: 100, inventorySkewBps: 0 });
  const ppmService = new PPMService({
    marketDataService,
    pricingEngine,
    treasuryClient,
    reservationRepo,
    treasuryRepo,
    broadcaster,
    logger,
    statsWindowMs: 60_000,
    now,
  });

  const orderService = new OrderService({
    db, orderRepo, matchRepo, orderBook, matchingEngine, onChainReader, broadcaster, logger,
    onMatch: () => {
      throw new Error('no user-user match expected in this test suite');
    },
    ppmService,
    reservationRepo,
    reservationReader,
    bootstrapPriceRepo,
    now,
  });
  orderServiceRef = orderService;

  /** Simulates the order owner's own wallet submitting settleWithProtocol: the order flips FILLED and the reservation flips EXECUTED on-chain. */
  const settleOnChain = (orderId: string, quoteId: string): void => {
    onChainRegistry.set(orderId, { ...onChainRegistry.get(orderId)!, state: 'FILLED' });
    reservationRegistry.set(quoteId, 'EXECUTED');
  };

  return { orderRepo, matchRepo, bootstrapPriceRepo, reservationRepo, treasuryRepo, onChainRegistry, reservationRegistry, events, orderService, ppmService, settleOnChain };
}

/**
 * Seeds a genuine, independent reference price (a prior trade at 1000) so
 * MarketDataService.referencePrice has something to quote from — see the
 * doc comment on referencePrice for why it never falls back to a one-sided
 * orderbook level (the incoming order would otherwise be its own reference).
 */
function seedReferencePrice(orderRepo: OrderRepository, matchRepo: MatchRepository): void {
  const priorBuy = { id: hexFill('f1'), asset: ASSET, side: 'BUY' as const, price: 1_000n, amount: 10n, commitment: hexFill('c1'), ownerId: hexFill('o1'), signature: hexFill('s1'), status: 'FILLED' as const, createdAt: Date.now(), expiresAt: 9_999_999_999n, payoutAddress: null };
  const priorSell = { ...priorBuy, id: hexFill('f2'), side: 'SELL' as const, ownerId: hexFill('o2') };
  orderRepo.insert(priorBuy);
  orderRepo.insert(priorSell);
  matchRepo.insert({ id: 'seed-match', buyOrderId: priorBuy.id, sellOrderId: priorSell.id, asset: ASSET, price: 1_000n, amount: 10n, matchedAt: Date.now() });
}

describe('PPM fill integration (pending-then-reconcile)', () => {
  it('No Liquidity Flow: an order with no user counterparty and an empty Treasury rests OPEN, unfilled', async () => {
    const { orderRepo, onChainRegistry, orderService, events } = buildSystem({ balance: 0n, reserved: 0n, available: 0n });

    const input = buildInput({ id: hexFill('01'), side: 'BUY', price: 1_100n, amount: 100n, ownerId: hexFill('bb'), signature: hexFill('dd'), payoutAddress: hexFill('99') });
    onChainRegistry.set(input.id, { state: 'OPEN', commitment: input.commitment });

    const result = await orderService.submitOrder(input);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.match).toBeNull();
    expect(result.protocolFill).toBeNull();
    expect(result.pendingProtocolQuote).toBeNull();
    expect(result.order.status).toBe('OPEN');
    expect(orderRepo.findById(input.id)?.status).toBe('OPEN');
    expect(events.map(([type]) => type)).toEqual(['order.created']); // no reservation, no fill
  });

  it('BUY fill is now PENDING, not immediate: the PPM reserves and returns a pending quote; the order stays OPEN until the buyer settles', async () => {
    const { orderRepo, matchRepo, reservationRepo, treasuryRepo, onChainRegistry, orderService, events } = buildSystem({
      balance: 10_000n,
      reserved: 0n,
      available: 10_000n,
    });
    seedReferencePrice(orderRepo, matchRepo);

    const input = buildInput({ id: hexFill('02'), side: 'BUY', price: 1_100n, amount: 100n, ownerId: hexFill('bb'), signature: hexFill('dd'), payoutAddress: hexFill('99') });
    onChainRegistry.set(input.id, { state: 'OPEN', commitment: input.commitment });

    const result = await orderService.submitOrder(input);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.match).toBeNull();
    expect(result.protocolFill).toBeNull(); // never auto-filled anymore
    expect(result.pendingProtocolQuote).not.toBeNull();
    expect(result.pendingProtocolQuote?.price).toBe(1_010n); // 1000 reference + 1% base spread
    expect(result.order.status).toBe('OPEN'); // rests OPEN, waiting for the buyer's wallet

    // A reservation is OPEN (not EXECUTED); only the RESERVE leg is recorded.
    const reservation = reservationRepo.findById(result.pendingProtocolQuote!.quoteId);
    expect(reservation?.state).toBe('OPEN');
    expect(treasuryRepo.listRecent(10).map((e) => e.kind)).toEqual(['RESERVE']);
    // The submitting session gets the quote in the HTTP response; other
    // sessions get order.ppm_quote_ready.
    expect(events.map(([type]) => type)).toEqual(['order.created', 'treasury.reserved', 'order.ppm_quote_ready']);
  });

  it('SELL fill happy path: reserve pending, then reconcile to FILLED after the seller settles on-chain', async () => {
    const { orderRepo, matchRepo, reservationRepo, treasuryRepo, onChainRegistry, orderService, events, settleOnChain } = buildSystem({
      balance: 500_000n,
      reserved: 0n,
      available: 500_000n,
    });
    seedReferencePrice(orderRepo, matchRepo);

    // SELL quote = 1000 - 1% = 990; crosses since limit 500 <= 990.
    const input = buildInput({ id: hexFill('03'), side: 'SELL', price: 500n, amount: 100n, ownerId: hexFill('bb'), signature: hexFill('dd') });
    onChainRegistry.set(input.id, { state: 'OPEN', commitment: input.commitment });

    const result = await orderService.submitOrder(input);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.pendingProtocolQuote).not.toBeNull();
    expect(result.pendingProtocolQuote?.price).toBe(990n);
    expect(result.order.status).toBe('OPEN');
    const quoteId = result.pendingProtocolQuote!.quoteId;

    // The seller's own wallet submits settleWithProtocol.
    settleOnChain(input.id, quoteId);

    // A reconciled read materializes the fill locally.
    const reconciled = await orderService.getOrderReconciled(input.id);
    expect(reconciled?.status).toBe('FILLED');
    expect(orderRepo.findById(input.id)?.status).toBe('FILLED');
    expect(reservationRepo.findById(quoteId)?.state).toBe('EXECUTED');
    expect(treasuryRepo.listRecent(10).map((e) => e.kind)).toEqual(['EXECUTE', 'RESERVE']);

    const filledEvent = events.find(([type]) => type === 'order.filled')?.[1] as { matchedWith: string };
    expect(filledEvent.matchedWith).toBe('protocol');
  });

  it('insufficient NIGHT liquidity for a SELL: the order rests OPEN with no reservation', async () => {
    // available covers the asset quote + risk limit, but not the NIGHT payment
    // (100 * 990 = 99_000).
    const { orderRepo, matchRepo, reservationRepo, onChainRegistry, orderService, events } = buildSystem({
      balance: 1_000n,
      reserved: 0n,
      available: 1_000n,
    });
    seedReferencePrice(orderRepo, matchRepo);

    const input = buildInput({ id: hexFill('04'), side: 'SELL', price: 500n, amount: 100n, ownerId: hexFill('bb'), signature: hexFill('dd') });
    onChainRegistry.set(input.id, { state: 'OPEN', commitment: input.commitment });

    const result = await orderService.submitOrder(input);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.pendingProtocolQuote).toBeNull();
    expect(result.order.status).toBe('OPEN');
    expect(reservationRepo.listByState('OPEN')).toHaveLength(0);
    expect(events.map(([type]) => type)).toEqual(['order.created']);
  });

  it('overbuy beyond available liquidity is rejected at the quote layer: the order rests OPEN, no reservation', async () => {
    const { orderRepo, matchRepo, reservationRepo, onChainRegistry, orderService } = buildSystem({
      balance: 50n,
      reserved: 0n,
      available: 50n,
    });
    seedReferencePrice(orderRepo, matchRepo);

    // amount 100 exceeds the 50 available — PricingEngine returns no quote.
    const input = buildInput({ id: hexFill('05'), side: 'BUY', price: 1_100n, amount: 100n, ownerId: hexFill('bb'), signature: hexFill('dd'), payoutAddress: hexFill('99') });
    onChainRegistry.set(input.id, { state: 'OPEN', commitment: input.commitment });

    const result = await orderService.submitOrder(input);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.pendingProtocolQuote).toBeNull();
    expect(result.order.status).toBe('OPEN');
    expect(reservationRepo.listByState('OPEN')).toHaveLength(0);
  });

  it('double reconciliation is a no-op: a second reconciled read does not re-emit order.filled or re-record EXECUTE', async () => {
    const { orderRepo, matchRepo, treasuryRepo, onChainRegistry, orderService, events, settleOnChain } = buildSystem({
      balance: 10_000n,
      reserved: 0n,
      available: 10_000n,
    });
    seedReferencePrice(orderRepo, matchRepo);

    const input = buildInput({ id: hexFill('06'), side: 'BUY', price: 1_100n, amount: 100n, ownerId: hexFill('bb'), signature: hexFill('dd'), payoutAddress: hexFill('99') });
    onChainRegistry.set(input.id, { state: 'OPEN', commitment: input.commitment });
    const result = await orderService.submitOrder(input);
    if (!result.ok || !result.pendingProtocolQuote) throw new Error('unreachable');

    settleOnChain(input.id, result.pendingProtocolQuote.quoteId);
    await orderService.getOrderReconciled(input.id);
    await orderService.getOrderReconciled(input.id); // second time: no-op

    expect(events.filter(([type]) => type === 'order.filled')).toHaveLength(1);
    expect(treasuryRepo.listRecent(10).filter((e) => e.kind === 'EXECUTE')).toHaveLength(1);
  });

  it('expired-unclaimed quote is reclaimed by the existing expiry sweep', async () => {
    let currentMs = 1_700_000_000_000;
    const { orderRepo, matchRepo, reservationRepo, onChainRegistry, orderService, ppmService } = buildSystem(
      { balance: 10_000n, reserved: 0n, available: 10_000n },
      () => currentMs,
    );
    seedReferencePrice(orderRepo, matchRepo);

    const input = buildInput({ id: hexFill('07'), side: 'BUY', price: 1_100n, amount: 100n, ownerId: hexFill('bb'), signature: hexFill('dd'), payoutAddress: hexFill('99') });
    onChainRegistry.set(input.id, { state: 'OPEN', commitment: input.commitment });
    const result = await orderService.submitOrder(input);
    if (!result.ok || !result.pendingProtocolQuote) throw new Error('unreachable');
    const quoteId = result.pendingProtocolQuote.quoteId;
    expect(reservationRepo.findById(quoteId)?.state).toBe('OPEN');

    // Advance past the quote TTL (120s) and sweep — the never-claimed quote is
    // released.
    currentMs += 200_000;
    const released = await ppmService.sweepExpiredReservations();
    expect(released).toBe(1);
    expect(reservationRepo.findById(quoteId)?.state).toBe('RELEASED');
  });
});
