import { describe, expect, it, vi } from 'vitest';

import { openDatabase } from '../../src/db/sqlite.js';
import { BootstrapPriceRepository } from '../../src/db/repositories/BootstrapPriceRepository.js';
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

const ASSET = hexFill('aa');
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
  readonly bootstrapPrice?: bigint;
}

function makeHarness(opts: HarnessOpts) {
  const db = openDatabase(':memory:');
  const reservationRepo = new ReservationRepository(db);
  const treasuryRepo = new TreasuryRepository(db);
  const bootstrapPriceRepo = new BootstrapPriceRepository(db);
  if (opts.bootstrapPrice !== undefined) bootstrapPriceRepo.set(ASSET, opts.bootstrapPrice, NOW_MS);

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
    bootstrapPriceRepo,
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
    statsWindowMs: 60_000,
    now: () => NOW_MS,
  });

  const orderRepo = new OrderRepository(db);
  return { service, reservationRepo, treasuryRepo, bootstrapPriceRepo, orderRepo, events, caller };
}

describe('PPMService.attemptFill', () => {
  it('reports "Protocol liquidity unavailable." when the Treasury has no liquidity for the asset', async () => {
    const { service } = makeHarness({ liquidity: { balance: 0n, reserved: 0n, available: 0n } });
    const result = await service.attemptFill(sampleOrder());
    expect(result).toEqual({ pending: false, reason: 'Protocol liquidity unavailable.' });
  });

  it('a virgin asset (no lastPrice, no bootstrap) still cannot be quoted — the cold-start case without a fix', async () => {
    const { service, caller } = makeHarness({
      liquidity: { balance: 10_000n, reserved: 0n, available: 10_000n },
      lastPrice: null,
    });
    const result = await service.attemptFill(sampleOrder({ price: 1_100n }));
    expect(result).toEqual({ pending: false, reason: 'Protocol liquidity unavailable.' });
    expect(caller.reserveLiquidity).not.toHaveBeenCalled();
  });

  it('a virgin asset with an admin-supplied bootstrap price gets a real quote', async () => {
    const { service, orderRepo } = makeHarness({
      liquidity: { balance: 10_000n, reserved: 0n, available: 10_000n },
      lastPrice: null,
      bootstrapPrice: 1_000n,
    });
    const order = sampleOrder({ price: 1_100n, amount: 100n });
    orderRepo.insert(order);

    const result = await service.attemptFill(order);
    expect(result.pending).toBe(true);
    if (!result.pending) throw new Error('unreachable');
    expect(result.price).toBe(1_010n); // bootstrap 1000 + 1% base spread
  });

  it("does not fill when the order's limit price does not cross the protocol's quote", async () => {
    // BUY quote at reference(1000) + 1% = 1010; order limit is 1000, below the quote.
    const { service, caller } = makeHarness({ liquidity: { balance: 10_000n, reserved: 0n, available: 10_000n } });
    const result = await service.attemptFill(sampleOrder({ price: 1_000n }));
    expect(result.pending).toBe(false);
    expect(caller.reserveLiquidity).not.toHaveBeenCalled();
  });

  it('a crossing BUY order reserves liquidity and returns a pending quote WITHOUT settling — settleWithProtocol is now the buyer wallet\'s job', async () => {
    const { service, reservationRepo, treasuryRepo, orderRepo, events, caller } = makeHarness({
      liquidity: { balance: 10_000n, reserved: 0n, available: 10_000n },
    });
    const order = sampleOrder({ price: 1_100n, amount: 100n });
    orderRepo.insert(order);

    const result = await service.attemptFill(order);

    expect(result.pending).toBe(true);
    if (!result.pending) throw new Error('unreachable');
    expect(result.side).toBe('BUY');
    expect(result.price).toBe(1_010n); // reference 1000 + 1% base spread
    expect(result.amount).toBe(100n);

    // The reservation is OPEN (not EXECUTED) and the settle call never fires.
    const reservation = reservationRepo.findById(result.quoteId);
    expect(reservation?.state).toBe('OPEN');
    expect(reservation?.orderId).toBe(order.id);
    expect(caller.settleWithProtocol).not.toHaveBeenCalled();

    // Only the RESERVE leg is recorded so far; EXECUTE comes at reconciliation.
    expect(treasuryRepo.listRecent(10).map((h) => h.kind)).toEqual(['RESERVE']);
    expect(events.map(([type]) => type)).toEqual(['treasury.reserved']);
  });

  it('a crossing SELL order with sufficient NIGHT liquidity reserves and returns a pending quote (SELL is now supported)', async () => {
    // SELL quote = reference(1000) - 1% = 990; payment = 100 * 990 = 99_000.
    // available must cover both the asset quote and the NIGHT payment.
    const { service, reservationRepo, orderRepo, caller } = makeHarness({
      liquidity: { balance: 200_000n, reserved: 0n, available: 200_000n },
    });
    const order = sampleOrder({ side: 'SELL', price: 500n, amount: 100n });
    orderRepo.insert(order);

    const result = await service.attemptFill(order);

    expect(result.pending).toBe(true);
    if (!result.pending) throw new Error('unreachable');
    expect(result.side).toBe('SELL');
    expect(result.price).toBe(990n);
    expect(reservationRepo.findById(result.quoteId)?.state).toBe('OPEN');
    expect(caller.settleWithProtocol).not.toHaveBeenCalled();
  });

  it('declines a crossing SELL order when the Treasury lacks enough NIGHT to pay the seller, without reserving', async () => {
    // available (1000) covers the asset quote + risk limit, but the NIGHT
    // payment (100 * 990 = 99_000) far exceeds it.
    const { service, orderRepo, caller } = makeHarness({ liquidity: { balance: 1_000n, reserved: 0n, available: 1_000n } });
    const order = sampleOrder({ side: 'SELL', price: 500n, amount: 100n });
    orderRepo.insert(order);

    const result = await service.attemptFill(order);

    expect(result.pending).toBe(false);
    if (result.pending) throw new Error('unreachable');
    expect(result.reason).toBe('Insufficient protocol NIGHT liquidity to pay the seller.');
    expect(caller.reserveLiquidity).not.toHaveBeenCalled();
  });

  it('does not reserve when reserveLiquidity fails on-chain, and never attempts settleWithProtocol', async () => {
    const { service, reservationRepo, caller } = makeHarness({
      liquidity: { balance: 10_000n, reserved: 0n, available: 10_000n },
      reserveFails: true,
    });
    const result = await service.attemptFill(sampleOrder());
    expect(result.pending).toBe(false);
    expect(caller.settleWithProtocol).not.toHaveBeenCalled();
    expect(reservationRepo.listByState('OPEN')).toHaveLength(0);
  });
});

describe('PPMService.markReservationExecuted', () => {
  it('transitions an OPEN reservation to EXECUTED and records an EXECUTE event; a second call is a no-op', async () => {
    const { service, reservationRepo, treasuryRepo, orderRepo } = makeHarness({
      liquidity: { balance: 10_000n, reserved: 0n, available: 10_000n },
    });
    const order = sampleOrder();
    orderRepo.insert(order);
    const pending = await service.attemptFill(order);
    expect(pending.pending).toBe(true);
    if (!pending.pending) throw new Error('unreachable');

    const first = service.markReservationExecuted(pending.quoteId);
    expect(first?.state).toBe('EXECUTED');
    expect(reservationRepo.findById(pending.quoteId)?.state).toBe('EXECUTED');
    expect(treasuryRepo.listRecent(10).map((h) => h.kind)).toEqual(['EXECUTE', 'RESERVE']);

    // Idempotent: reconciling twice does not record a second EXECUTE row.
    service.markReservationExecuted(pending.quoteId);
    expect(treasuryRepo.listRecent(10).filter((h) => h.kind === 'EXECUTE')).toHaveLength(1);
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
