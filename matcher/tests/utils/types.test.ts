import { describe, expect, it } from 'vitest';

import { assetKey, assetsEqual } from '../../src/types/Asset.js';
import { isExpired } from '../../src/types/Order.js';
import { isSide, oppositeSide } from '../../src/types/Side.js';
import { isOrderStatus, isTerminalStatus } from '../../src/types/Status.js';

describe('Side', () => {
  it('oppositeSide flips BUY/SELL', () => {
    expect(oppositeSide('BUY')).toBe('SELL');
    expect(oppositeSide('SELL')).toBe('BUY');
  });

  it('isSide validates', () => {
    expect(isSide('BUY')).toBe(true);
    expect(isSide('HOLD')).toBe(false);
  });
});

describe('Status', () => {
  it('classifies terminal statuses correctly', () => {
    expect(isTerminalStatus('FILLED')).toBe(true);
    expect(isTerminalStatus('CANCELLED')).toBe(true);
    expect(isTerminalStatus('EXPIRED')).toBe(true);
    expect(isTerminalStatus('FAILED')).toBe(true);
    expect(isTerminalStatus('OPEN')).toBe(false);
    expect(isTerminalStatus('MATCHED')).toBe(false);
    expect(isTerminalStatus('SETTLING')).toBe(false);
  });

  it('isOrderStatus validates', () => {
    expect(isOrderStatus('OPEN')).toBe(true);
    expect(isOrderStatus('BOGUS')).toBe(false);
  });
});

describe('Asset', () => {
  const left = 'a'.repeat(64);
  const right = 'b'.repeat(64);

  it('assetKey distinguishes isLeft', () => {
    expect(assetKey({ isLeft: true, left, right })).not.toBe(assetKey({ isLeft: false, left, right }));
  });

  it('assetKey encodes the full tuple, not just the active branch (mirrors contract == semantics)', () => {
    const a = { isLeft: true, left, right: 'c'.repeat(64) };
    const b = { isLeft: true, left, right: 'd'.repeat(64) };
    expect(assetKey(a)).not.toBe(assetKey(b));
    expect(assetsEqual(a, b)).toBe(false);
  });

  it('assetsEqual requires all three fields to match', () => {
    const a = { isLeft: true, left, right };
    expect(assetsEqual(a, { ...a })).toBe(true);
    expect(assetsEqual(a, { ...a, isLeft: false })).toBe(false);
  });
});

describe('Order.isExpired', () => {
  it('treats expiresAt as exclusive-of-future, inclusive-at-boundary (mirrors contract blockTimeGte)', () => {
    expect(isExpired({ expiresAt: 100n }, 99n)).toBe(false);
    expect(isExpired({ expiresAt: 100n }, 100n)).toBe(true);
    expect(isExpired({ expiresAt: 100n }, 101n)).toBe(true);
  });
});
