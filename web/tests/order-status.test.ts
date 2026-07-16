import { describe, expect, it } from 'vitest';
import { expiryToUnixSeconds, statusToStageIndex } from '../src/lib/order-status';

describe('statusToStageIndex', () => {
  it('maps every live order status to a strictly increasing timeline stage', () => {
    expect(statusToStageIndex('OPEN')).toBe(1);
    expect(statusToStageIndex('MATCHED')).toBe(2);
    expect(statusToStageIndex('SETTLING')).toBe(3);
    expect(statusToStageIndex('FILLED')).toBe(4);
  });

  it('maps terminal non-fill statuses back to stage 0, not a stale in-flight stage', () => {
    expect(statusToStageIndex('CANCELLED')).toBe(0);
    expect(statusToStageIndex('EXPIRED')).toBe(0);
    expect(statusToStageIndex('FAILED')).toBe(0);
  });
});

describe('expiryToUnixSeconds', () => {
  it('converts relative expiry options into a future unix-second deadline', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(expiryToUnixSeconds('10m')).toBeGreaterThanOrEqual(now + 600 - 2);
    expect(expiryToUnixSeconds('10m')).toBeLessThanOrEqual(now + 600 + 2);
    expect(expiryToUnixSeconds('1h')).toBeGreaterThanOrEqual(now + 3600 - 2);
  });

  it('maps GTC to the Uint<64>-sentinel the contract treats as "never expires"', () => {
    expect(expiryToUnixSeconds('GTC')).toBe(9999999999);
  });
});
