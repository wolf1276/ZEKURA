import { describe, expect, it, vi } from 'vitest';

import { openDatabase } from '../../src/db/sqlite.js';
import { OrderRepository } from '../../src/db/repositories/OrderRepository.js';
import { ReservationRepository } from '../../src/db/repositories/ReservationRepository.js';
import { TreasuryRepository } from '../../src/db/repositories/TreasuryRepository.js';
import { MarketDataService } from '../../src/services/MarketDataService.js';
import { PricingEngine, DEFAULT_PRICING_CONFIG } from '../../src/ppm/PricingEngine.js';
import { PPMService } from '../../src/ppm/PPMService.js';
import {
  TreasuryClient,
  type OnChainTreasuryReader,
  type PpmCircuitCaller,
  type TreasuryLiquidity,
} from '../../src/ppm/TreasuryClient.js';
import type { Order } from '../../src/types/Order.js';
import { createLogger } from '../../src/utils/logger.js';
import type { Broadcaster } from '../../src/websocket/SocketServer.js';

const logger = createLogger('test', { level: 'silent' });

function hexFill(byte: string): string {
  return byte.repeat(32);
}

const ASSET = { isLeft: true, left: hexFill('aa'), right: hexFill('00') };
const ON_CHAIN_ASSET_KEY = hexFill('11');
const NOW_MS = 1_700_000_000_000;

function sampleOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: hexFill('01'),
    asset: ASSET,
    side: 'BUY',
    price: 1_100n,
    amount: 100n,
    commitment: hexFill('cc'),
    ownerId: hexFill('bb'),
    signature: hexFill('dd'),
    status: 'OPEN',
    createdAt: NOW_MS,
    expiresAt: 9_999_999_999n,
    payoutAddress: hexFill('99'),
    ...overrides,
  };
}

interface HarnessOpts {
  readonly liquidity: TreasuryLiquidity;
  readonly reserveFails?: boolean;
  readonly settleFails?: boolean;
  readonly releaseFails?: boolean;
  readonly lastPrice?: bigint | null;
}

function makeHarness(opts: HarnessOpts) {
  const db = openDatabase(':memory:');
  const reservationRepo = new ReservationRepository(db);
  const treasuryRepo = new TreasuryRepository(db);

  const caller: PpmCircuitCaller = {
    reserveLiquidity: vi.fn(async () => {
      if (opts.reserveFails) throw new Error('reserve failed');
      return { public: { txId: 'reserve-tx' } };
    }),
    releaseLiquidity: vi.fn(async () => {
      if (opts.releaseFails) throw new Error('release failed');
      return { public: { txId: 'release-tx' } };
    }),
    releaseExpiredLiquidity: vi.fn(async () => ({ public: { txId: 'expire-tx' } })),
    settleWithProtocol: vi.fn(async () => {
      if (opts.settleFails) throw new Error('settle failed');
      return { public: { txId: 'settle-tx' } };
    }),
    depositTreasury: vi.fn(),
    withdrawTreasury: vi.fn(async (): Promise<{ public: { txId: string } }> => ({ public: { txId: 'withdraw-tx' } })),
  };
  const reader: OnChainTreasuryReader = { getLiquidity: vi.fn(async () => opts.liquidity) };
  const treasuryClient = new TreasuryClient(caller, reader, logger);

  const events: Array<[string, unknown]> = [];
  const broadcaster: Broadcaster = { broadcast: (type, payload) => void events.push([type, payload]) };

  const marketDataService = new MarketDataService({
    getOrderBookSnapshot: () => ({ asset: ASSET, bids: [], asks: [] }),
    getMarketStats: () => ({
      asset: ASSET,
      lastPrice: opts.lastPrice === undefined ? 1_000n : opts.lastPrice,
      openPrice: 1_000n,
      high: 1_000n,
      low: 1_000n,
      volumeBase: 0n,
      tradeCount: 0,
      changePct: null,
    }),
    treasuryClient,
    toOnChainAssetKey: () => ON_CHAIN_ASSET_KEY,
  });

  const pricingEngine = new PricingEngine({ ...DEFAULT_PRICING_CONFIG, baseSpreadBps: 100, inventorySkewBps: 0 });

  const service = new PPMService({
    marketDataService,
    pricingEngine,
    treasuryClient,
    reservationRepo,
    treasuryRepo,
    broadcaster,
    logger,
    toOnChainAssetKey: () => ON_CHAIN_ASSET_KEY,
    statsWindowMs: 60_000,
    now: () => NOW_MS,
  });

  const orderRepo = new OrderRepository(db);
  return { service, reservationRepo, treasuryRepo, orderRepo, events, caller };
}

describe('PPMService.attemptFill', () => {
  it('reports "Protocol liquidity unavailable." when the Treasury has no liquidity for the asset', async () => {
    const { service } = makeHarness({ liquidity: { balance: 0n, reserved: 0n, available: 0n } });
    const result = await service.attemptFill(sampleOrder());
    expect(result).toEqual({ filled: false, reason: 'Protocol liquidity unavailable.' });
  });

  it("does not fill when the order's limit price does not cross the protocol's quote", async () => {
    // BUY quote at reference(1000) + 1% = 1010; order limit is 1000, below the quote.
    const { service } = makeHarness({ liquidity: { balance: 10_000n, reserved: 0n, available: 10_000n } });
    const result = await service.attemptFill(sampleOrder({ price: 1_000n }));
    expect(result.filled).toBe(false);
  });

  it('does not fill a BUY order with no payoutAddress on file', async () => {
    const { service } = makeHarness({ liquidity: { balance: 10_000n, reserved: 0n, available: 10_000n } });
    const result = await service.attemptFill(sampleOrder({ payoutAddress: null }));
    expect(result).toEqual({
      filled: false,
      reason: 'Order has no payout address on file — cannot receive a protocol-liquidity fill (see Order.payoutAddress)',
    });
  });

  it('fills a crossing BUY order: reserves then settles, persists an EXECUTED reservation and RESERVE+EXECUTE treasury_events rows', async () => {
    const { service, reservationRepo, treasuryRepo, orderRepo, events, caller } = makeHarness({
      liquidity: { balance: 10_000n, reserved: 0n, available: 10_000n },
    });
    const order = sampleOrder({ price: 1_100n, amount: 100n });
    orderRepo.insert(order);

    const result = await service.attemptFill(order);

    expect(result.filled).toBe(true);
    if (!result.filled) throw new Error('unreachable');
    expect(result.price).toBe(1_010n);
    expect(result.amount).toBe(100n);
    expect(result.txId).toBe('settle-tx');

    const reservation = reservationRepo.findById(result.quoteId);
    expect(reservation?.state).toBe('EXECUTED');
    expect(reservation?.orderId).toBe(order.id);
    expect(reservation?.amount).toBe(100n);

    const history = treasuryRepo.listRecent(10);
    expect(history.map((h) => h.kind)).toEqual(['EXECUTE', 'RESERVE']); // newest first

    expect(events.map(([type]) => type)).toEqual(['treasury.reserved']);
    expect(caller.settleWithProtocol).toHaveBeenCalledTimes(1);
  });

  it('fills a crossing SELL order without requiring a payoutAddress', async () => {
    const { service, orderRepo } = makeHarness({ liquidity: { balance: 10_000n, reserved: 0n, available: 10_000n } });
    const order = sampleOrder({ side: 'SELL', price: 900n, payoutAddress: null });
    orderRepo.insert(order);

    const result = await service.attemptFill(order);

    expect(result.filled).toBe(true);
    if (!result.filled) throw new Error('unreachable');
    expect(result.price).toBe(990n); // 1000 - 1%
  });

  it('does not fill when reserveLiquidity fails on-chain, and never attempts settleWithProtocol', async () => {
    const { service, caller } = makeHarness({
      liquidity: { balance: 10_000n, reserved: 0n, available: 10_000n },
      reserveFails: true,
    });
    const result = await service.attemptFill(sampleOrder());
    expect(result.filled).toBe(false);
    expect(caller.settleWithProtocol).not.toHaveBeenCalled();
  });

  it('releases the reservation (best-effort) when settleWithProtocol fails, and the reservation ends up RELEASED', async () => {
    const { service, reservationRepo, treasuryRepo, orderRepo, events } = makeHarness({
      liquidity: { balance: 10_000n, reserved: 0n, available: 10_000n },
      settleFails: true,
    });
    const order = sampleOrder();
    orderRepo.insert(order);
    const result = await service.attemptFill(order);

    expect(result.filled).toBe(false);
    const reservations = reservationRepo.listByState('RELEASED');
    expect(reservations).toHaveLength(1);
    expect(treasuryRepo.listRecent(10).map((h) => h.kind)).toEqual(['RELEASE', 'RESERVE']);
    expect(events.map(([type]) => type)).toEqual(['treasury.reserved', 'treasury.released']);
  });

  it('leaves the reservation OPEN (for later expiry sweep) when both settleWithProtocol and the best-effort release fail', async () => {
    const { service, reservationRepo, orderRepo } = makeHarness({
      liquidity: { balance: 10_000n, reserved: 0n, available: 10_000n },
      settleFails: true,
      releaseFails: true,
    });
    const order = sampleOrder();
    orderRepo.insert(order);
    const result = await service.attemptFill(order);

    expect(result.filled).toBe(false);
    expect(reservationRepo.listByState('OPEN')).toHaveLength(1);
  });
});

describe('PPMService.sweepExpiredReservations', () => {
  it('releases only OPEN reservations past their expiresAt, leaving others untouched', async () => {
    const { service, reservationRepo } = makeHarness({ liquidity: { balance: 10_000n, reserved: 0n, available: 10_000n } });

    const nowSeconds = BigInt(Math.floor(NOW_MS / 1000));
    reservationRepo.insert({
      quoteId: hexFill('a1'),
      orderId: null,
      assetKey: ON_CHAIN_ASSET_KEY,
      amount: 10n,
      price: 1n,
      expiresAt: nowSeconds - 100n, // expired
      state: 'OPEN',
      createdAt: NOW_MS,
      updatedAt: NOW_MS,
    });
    reservationRepo.insert({
      quoteId: hexFill('a2'),
      orderId: null,
      assetKey: ON_CHAIN_ASSET_KEY,
      amount: 10n,
      price: 1n,
      expiresAt: nowSeconds + 100n, // not yet expired
      state: 'OPEN',
      createdAt: NOW_MS,
      updatedAt: NOW_MS,
    });

    const released = await service.sweepExpiredReservations();

    expect(released).toBe(1);
    expect(reservationRepo.findById(hexFill('a1'))?.state).toBe('RELEASED');
    expect(reservationRepo.findById(hexFill('a2'))?.state).toBe('OPEN');
  });
});
