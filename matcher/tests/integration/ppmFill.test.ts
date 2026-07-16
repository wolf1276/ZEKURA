import { describe, expect, it } from 'vitest';

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
import { TreasuryClient, type OnChainTreasuryReader, type PpmCircuitCaller, type TreasuryLiquidity } from '../../src/ppm/TreasuryClient.js';
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

const ASSET = { isLeft: true, left: hexFill('aa'), right: hexFill('00') };
const ON_CHAIN_ASSET_KEY = hexFill('55');

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
 * — only the on-chain seam (PpmCircuitCaller/OnChainTreasuryReader) is
 * faked, exactly as src/index.ts would inject real ones. `liquidity`
 * controls what the fake Treasury reports available.
 */
function buildSystem(liquidity: TreasuryLiquidity) {
  const db = openDatabase(':memory:');
  const orderRepo = new OrderRepository(db);
  const matchRepo = new MatchRepository(db);
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

  const events: Array<[MatcherEventType, unknown]> = [];
  const broadcaster: Broadcaster = { broadcast: (type, payload) => events.push([type, payload]) };

  const ppmCaller: PpmCircuitCaller = {
    reserveLiquidity: async () => ({ public: { txId: 'reserve-tx' } }),
    releaseLiquidity: async () => ({ public: { txId: 'release-tx' } }),
    releaseExpiredLiquidity: async () => ({ public: { txId: 'expire-tx' } }),
    settleWithProtocol: async (orderId) => {
      const id = Buffer.from(orderId).toString('hex');
      onChainRegistry.set(id, { ...onChainRegistry.get(id)!, state: 'FILLED' });
      return { public: { txId: 'settle-tx' } };
    },
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
    toOnChainAssetKey: () => ON_CHAIN_ASSET_KEY,
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
    toOnChainAssetKey: () => ON_CHAIN_ASSET_KEY,
    statsWindowMs: 60_000,
  });

  const orderService = new OrderService({
    db, orderRepo, matchRepo, orderBook, matchingEngine, onChainReader, broadcaster, logger,
    onMatch: () => {
      throw new Error('no user-user match expected in this test suite');
    },
    ppmService,
  });
  orderServiceRef = orderService;

  return { orderRepo, matchRepo, reservationRepo, treasuryRepo, onChainRegistry, events, orderService };
}

describe('PPM fill integration', () => {
  it('No Liquidity Flow: an order with no user counterparty and an empty Treasury rests OPEN, unfilled', async () => {
    const { orderRepo, onChainRegistry, orderService, events } = buildSystem({ balance: 0n, reserved: 0n, available: 0n });

    const input = buildInput({ id: hexFill('01'), side: 'BUY', price: 1_100n, amount: 100n, ownerId: hexFill('bb'), signature: hexFill('dd'), payoutAddress: hexFill('99') });
    onChainRegistry.set(input.id, { state: 'OPEN', commitment: input.commitment });

    const result = await orderService.submitOrder(input);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.match).toBeNull();
    expect(result.protocolFill).toBeNull();
    expect(result.order.status).toBe('OPEN');
    expect(orderRepo.findById(input.id)?.status).toBe('OPEN');
    expect(events.map(([type]) => type)).toEqual(['order.created']); // no order.filled — it just rests
  });

  it('PPM Match: an order with no user counterparty but sufficient Treasury liquidity is filled by the protocol', async () => {
    const { orderRepo, matchRepo, reservationRepo, treasuryRepo, onChainRegistry, orderService, events } = buildSystem({
      balance: 10_000n,
      reserved: 0n,
      available: 10_000n,
    });

    // Seeds a genuine, independent reference price (a prior trade at 1000)
    // — MarketDataService.referencePrice deliberately never falls back to a
    // one-sided orderbook level (see its doc comment), since the incoming
    // order below would otherwise be resting in the book on its own side
    // and become a circular "reference" for pricing itself.
    const priorBuy = { id: hexFill('f1'), asset: ASSET, side: 'BUY' as const, price: 1_000n, amount: 10n, commitment: hexFill('c1'), ownerId: hexFill('o1'), signature: hexFill('s1'), status: 'FILLED' as const, createdAt: Date.now(), expiresAt: 9_999_999_999n, payoutAddress: null };
    const priorSell = { ...priorBuy, id: hexFill('f2'), side: 'SELL' as const, ownerId: hexFill('o2') };
    orderRepo.insert(priorBuy);
    orderRepo.insert(priorSell);
    matchRepo.insert({ id: 'seed-match', buyOrderId: priorBuy.id, sellOrderId: priorSell.id, asset: ASSET, price: 1_000n, amount: 10n, matchedAt: Date.now() });

    const input = buildInput({ id: hexFill('02'), side: 'BUY', price: 1_100n, amount: 100n, ownerId: hexFill('bb'), signature: hexFill('dd'), payoutAddress: hexFill('99') });
    onChainRegistry.set(input.id, { state: 'OPEN', commitment: input.commitment });

    const result = await orderService.submitOrder(input);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.match).toBeNull();
    expect(result.protocolFill).not.toBeNull();
    expect(result.protocolFill?.price).toBe(1_010n); // 1000 reference + 1% base spread
    expect(result.order.status).toBe('FILLED');

    // Settlement Updates: the order's off-chain record reflects the fill.
    expect(orderRepo.findById(input.id)?.status).toBe('FILLED');
    // Treasury Updates: a reservation was opened and executed, and both
    // legs are recorded in the local Treasury history mirror.
    const reservation = reservationRepo.findById(result.protocolFill!.quoteId);
    expect(reservation?.state).toBe('EXECUTED');
    expect(treasuryRepo.listRecent(10).map((e) => e.kind)).toEqual(['EXECUTE', 'RESERVE']);
    // Frontend Updates: broadcasts carry enough for a "Matched With: Protocol Liquidity" badge.
    expect(events.map(([type]) => type)).toEqual(['order.created', 'treasury.reserved', 'order.filled']);
    const filledEvent = events.find(([type]) => type === 'order.filled')?.[1] as { matchedWith: string };
    expect(filledEvent.matchedWith).toBe('protocol');
  });
});
