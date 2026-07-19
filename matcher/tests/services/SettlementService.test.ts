import type Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import { MatchRepository } from '../../src/db/repositories/MatchRepository.js';
import { OrderRepository } from '../../src/db/repositories/OrderRepository.js';
import { openDatabase } from '../../src/db/sqlite.js';
import type { Match } from '../../src/matcher/Match.js';
import { SettlementService } from '../../src/services/SettlementService.js';
import { SettlementClient, type OnChainOrderReader, type OnChainOrderRecord, type SettleCircuitCaller } from '../../src/settlement/SettlementClient.js';
import { SettlementQueue } from '../../src/settlement/SettlementQueue.js';
import type { Order } from '../../src/types/Order.js';
import { createLogger } from '../../src/utils/logger.js';
import type { Broadcaster } from '../../src/websocket/SocketServer.js';

const logger = createLogger('test', { level: 'silent' });

function hexFill(byte: string): string {
  return byte.repeat(32);
}

const ASSET = hexFill('aa');
const BUY_ID = hexFill('01');
const SELL_ID = hexFill('02');

function sampleOrder(id: string, side: 'BUY' | 'SELL', status: Order['status']): Order {
  return {
    id,
    asset: ASSET,
    side,
    price: 100n,
    amount: 10n,
    commitment: hexFill('cc'),
    ownerId: hexFill('bb'),
    signature: hexFill('dd'),
    status,
    createdAt: Date.now(),
    expiresAt: 9_999_999_999n,
  };
}

function sampleMatch(): Match {
  return { id: 'match-1', buyOrderId: BUY_ID, sellOrderId: SELL_ID, asset: ASSET, price: 100n, amount: 10n, matchedAt: Date.now() };
}

class FakeOnChainReader implements OnChainOrderReader {
  constructor(private states: Map<string, OnChainOrderRecord>) {}
  async getOrder(orderId: string): Promise<OnChainOrderRecord> {
    return this.states.get(orderId) ?? { state: 'NOT_FOUND', commitment: null };
  }
}

function makeHarness(caller: SettleCircuitCaller, onChainStates: Map<string, OnChainOrderRecord>) {
  const db = openDatabase(':memory:');
  const orderRepo = new OrderRepository(db);
  const matchRepo = new MatchRepository(db);
  orderRepo.insert(sampleOrder(BUY_ID, 'BUY', 'MATCHED'));
  orderRepo.insert(sampleOrder(SELL_ID, 'SELL', 'MATCHED'));
  const match = sampleMatch();
  matchRepo.insert(match);

  const reader = new FakeOnChainReader(onChainStates);
  const settlementClient = new SettlementClient(caller, reader, logger);
  const queue = new SettlementQueue({ maxRetries: 2, retryDelayMs: 5 }, logger);
  const events: Array<[string, unknown]> = [];
  const broadcaster: Broadcaster = { broadcast: (type, payload) => events.push([type, payload]) };

  const service = new SettlementService({ db, orderRepo, matchRepo, settlementClient, queue, broadcaster, logger });
  return { db, orderRepo, matchRepo, match, events, service, queue };
}

function settlementRow(db: Database.Database, matchId: string) {
  return db.prepare('SELECT * FROM settlements WHERE match_id = ?').get(matchId) as
    | { status: string; tx_id: string | null; attempts: number; error: string | null }
    | undefined;
}

describe('SettlementService.handleMatch', () => {
  it('settles successfully: flips both orders to FILLED and records a SUCCESS settlement row', async () => {
    const caller: SettleCircuitCaller = { settle: vi.fn().mockResolvedValue({ public: { txId: 'tx-1' } }) };
    const { orderRepo, match, events, service, db, queue } = makeHarness(caller, new Map());

    service.handleMatch(match);
    await vi.waitFor(() => expect(queue.isInFlight(match.id)).toBe(false));

    expect(orderRepo.findById(BUY_ID)?.status).toBe('FILLED');
    expect(orderRepo.findById(SELL_ID)?.status).toBe('FILLED');
    const row = settlementRow(db, match.id);
    expect(row?.status).toBe('SUCCESS');
    expect(row?.tx_id).toBe('tx-1');
    expect(events.map(([t]) => t)).toEqual(['order.settling', 'order.filled']);
  });

  it('retries a transient failure (both orders still OPEN on-chain) and eventually succeeds', async () => {
    let attempts = 0;
    const caller: SettleCircuitCaller = {
      settle: vi.fn(async () => {
        attempts++;
        if (attempts < 2) throw new Error('proof server hiccup');
        return { public: { txId: 'tx-recovered' } };
      }),
    };
    const onChainStates = new Map<string, OnChainOrderRecord>([
      [BUY_ID, { state: 'OPEN', commitment: 'x' }],
      [SELL_ID, { state: 'OPEN', commitment: 'x' }],
    ]);
    const { orderRepo, match, service, db, queue } = makeHarness(caller, onChainStates);

    service.handleMatch(match);
    await vi.waitFor(() => expect(queue.isInFlight(match.id)).toBe(false), { timeout: 2000 });

    expect(attempts).toBe(2);
    expect(orderRepo.findById(BUY_ID)?.status).toBe('FILLED');
    expect(settlementRow(db, match.id)?.status).toBe('SUCCESS');
  });

  it('recognizes success despite a reported error when on-chain state shows both orders already FILLED', async () => {
    const caller: SettleCircuitCaller = { settle: vi.fn().mockRejectedValue(new Error('response lost after chain applied it')) };
    const onChainStates = new Map<string, OnChainOrderRecord>([
      [BUY_ID, { state: 'FILLED', commitment: 'x' }],
      [SELL_ID, { state: 'FILLED', commitment: 'x' }],
    ]);
    const { orderRepo, match, service, db, queue } = makeHarness(caller, onChainStates);

    service.handleMatch(match);
    await vi.waitFor(() => expect(queue.isInFlight(match.id)).toBe(false));

    expect(orderRepo.findById(BUY_ID)?.status).toBe('FILLED');
    expect(orderRepo.findById(SELL_ID)?.status).toBe('FILLED');
    expect(settlementRow(db, match.id)?.status).toBe('SUCCESS');
    expect(caller.settle).toHaveBeenCalledTimes(1); // recovered immediately, no pointless retries
  });

  it('marks both orders FAILED when on-chain state diverges permanently (no longer OPEN, not FILLED)', async () => {
    const caller: SettleCircuitCaller = { settle: vi.fn().mockRejectedValue(new Error('sell order was expired')) };
    const onChainStates = new Map<string, OnChainOrderRecord>([
      [BUY_ID, { state: 'OPEN', commitment: 'x' }],
      [SELL_ID, { state: 'EXPIRED', commitment: 'x' }],
    ]);
    const { orderRepo, match, events, service, db, queue } = makeHarness(caller, onChainStates);

    service.handleMatch(match);
    await vi.waitFor(() => expect(queue.isInFlight(match.id)).toBe(false));

    expect(orderRepo.findById(BUY_ID)?.status).toBe('FAILED');
    expect(orderRepo.findById(SELL_ID)?.status).toBe('FAILED');
    expect(settlementRow(db, match.id)?.status).toBe('FAILED');
    expect(caller.settle).toHaveBeenCalledTimes(1); // permanent — never retried
    expect(events.map(([t]) => t)).toEqual(['order.settling', 'order.failed']);
  });

  it('marks both orders FAILED once the retry budget is exhausted while transiently failing', async () => {
    const caller: SettleCircuitCaller = { settle: vi.fn().mockRejectedValue(new Error('always fails')) };
    const onChainStates = new Map<string, OnChainOrderRecord>([
      [BUY_ID, { state: 'OPEN', commitment: 'x' }],
      [SELL_ID, { state: 'OPEN', commitment: 'x' }],
    ]);
    const { orderRepo, match, service, db, queue } = makeHarness(caller, onChainStates);

    service.handleMatch(match);
    await vi.waitFor(() => expect(queue.isInFlight(match.id)).toBe(false), { timeout: 2000 });

    expect(caller.settle).toHaveBeenCalledTimes(3); // maxRetries(2) + 1 initial attempt
    expect(orderRepo.findById(BUY_ID)?.status).toBe('FAILED');
    expect(settlementRow(db, match.id)?.status).toBe('FAILED');
    expect(settlementRow(db, match.id)?.attempts).toBe(3);
  });

  it('never double-settles: enqueuing the same match twice while it is in flight only calls settle() once', async () => {
    const caller: SettleCircuitCaller = { settle: vi.fn().mockResolvedValue({ public: { txId: 'tx-1' } }) };
    const { match, service, queue } = makeHarness(caller, new Map());

    service.handleMatch(match);
    service.handleMatch(match); // duplicate — must be a no-op (SettlementQueue is single-flight per key)
    await vi.waitFor(() => expect(queue.isInFlight(match.id)).toBe(false));

    expect(caller.settle).toHaveBeenCalledTimes(1);
  });
});

describe('SettlementService.recoverPendingSettlements', () => {
  it('re-enqueues matches left MATCHED/SETTLING by a previous run', async () => {
    const caller: SettleCircuitCaller = { settle: vi.fn().mockResolvedValue({ public: { txId: 'tx-1' } }) };
    const { orderRepo, service, queue } = makeHarness(caller, new Map());

    const recovered = service.recoverPendingSettlements();
    expect(recovered).toBe(1);
    await vi.waitFor(() => expect(queue.isInFlight('match-1')).toBe(false));
    expect(orderRepo.findById(BUY_ID)?.status).toBe('FILLED');
  });

  it('finds nothing to recover once all matches are terminal', () => {
    const caller: SettleCircuitCaller = { settle: vi.fn() };
    const { orderRepo, service } = makeHarness(caller, new Map());
    orderRepo.updateStatus(BUY_ID, 'FILLED');
    orderRepo.updateStatus(SELL_ID, 'FILLED');
    expect(service.recoverPendingSettlements()).toBe(0);
  });
});
