import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { MatchRepository } from '../../src/db/repositories/MatchRepository.js';
import { OrderRepository } from '../../src/db/repositories/OrderRepository.js';
import { openDatabase } from '../../src/db/sqlite.js';
import type { Match } from '../../src/matcher/Match.js';
import { assetKey } from '../../src/types/Asset.js';
import type { Order } from '../../src/types/Order.js';

function hexFill(byte: string): string {
  return byte.repeat(32);
}

const ASSET = hexFill('aa');

function sampleOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: hexFill('01'),
    asset: ASSET,
    side: 'BUY',
    price: 1_000n,
    amount: 500n,
    commitment: hexFill('cc'),
    ownerId: hexFill('bb'),
    signature: hexFill('dd'),
    status: 'OPEN',
    createdAt: Date.now(),
    expiresAt: 9_999_999_999n,
    ...overrides,
  };
}

function sampleMatch(overrides: Partial<Match> = {}): Match {
  return {
    id: 'match-1',
    buyOrderId: hexFill('01'),
    sellOrderId: hexFill('02'),
    asset: ASSET,
    price: 1_000n,
    amount: 500n,
    matchedAt: Date.now(),
    ...overrides,
  };
}

describe('MatchRepository', () => {
  let db: Database.Database;
  let orderRepo: OrderRepository;
  let matchRepo: MatchRepository;

  beforeEach(() => {
    db = openDatabase(':memory:');
    orderRepo = new OrderRepository(db);
    matchRepo = new MatchRepository(db);
    orderRepo.insert(sampleOrder({ id: hexFill('01'), side: 'BUY', status: 'MATCHED' }));
    orderRepo.insert(sampleOrder({ id: hexFill('02'), side: 'SELL', status: 'MATCHED' }));
  });

  it('inserts and reads back a match', () => {
    const match = sampleMatch();
    matchRepo.insert(match);
    expect(matchRepo.findById(match.id)).toEqual(match);
  });

  it('findByOrderId finds a match by either side', () => {
    const match = sampleMatch();
    matchRepo.insert(match);
    expect(matchRepo.findByOrderId(hexFill('01'))?.id).toBe(match.id);
    expect(matchRepo.findByOrderId(hexFill('02'))?.id).toBe(match.id);
  });

  it('listByOrderStatus finds matches whose orders are still MATCHED/SETTLING (settlement recovery)', () => {
    const match = sampleMatch();
    matchRepo.insert(match);
    const unsettled = matchRepo.listByOrderStatus(['MATCHED', 'SETTLING']);
    expect(unsettled.map((m) => m.id)).toEqual([match.id]);
  });

  it('listByOrderStatus excludes matches whose orders have already reached a terminal status', () => {
    matchRepo.insert(sampleMatch());
    orderRepo.updateStatus(hexFill('01'), 'FILLED');
    orderRepo.updateStatus(hexFill('02'), 'FILLED');
    expect(matchRepo.listByOrderStatus(['MATCHED', 'SETTLING'])).toEqual([]);
  });

  it('listByOrderStatus returns [] for an empty status list without querying', () => {
    matchRepo.insert(sampleMatch());
    expect(matchRepo.listByOrderStatus([])).toEqual([]);
  });

  it('listRecentByAssetKey returns trades for that asset, newest first, capped at limit', () => {
    matchRepo.insert(sampleMatch({ id: 'm1', matchedAt: 100 }));
    matchRepo.insert(sampleMatch({ id: 'm2', matchedAt: 300 }));
    matchRepo.insert(sampleMatch({ id: 'm3', matchedAt: 200 }));
    const recent = matchRepo.listRecentByAssetKey(assetKey(ASSET), 2);
    expect(recent.map((m) => m.id)).toEqual(['m2', 'm3']);
  });

  it('listSinceByAssetKey returns trades at or after the cutoff, oldest first', () => {
    matchRepo.insert(sampleMatch({ id: 'm1', matchedAt: 100 }));
    matchRepo.insert(sampleMatch({ id: 'm2', matchedAt: 300 }));
    matchRepo.insert(sampleMatch({ id: 'm3', matchedAt: 200 }));
    const since = matchRepo.listSinceByAssetKey(assetKey(ASSET), 200);
    expect(since.map((m) => m.id)).toEqual(['m3', 'm2']);
  });
});
