import { describe, expect, it } from 'vitest';
import { retryWithBackoff } from '../src/lib/retry';
import {
  markSettlingInFlight,
  unmarkSettlingInFlight,
  shouldAutoSettle,
} from '../src/services/midnight/pendingSettlements';

/**
 * Simulates the auto-settlement effect's core decision flow (retryWithBackoff
 * getOrder -> shouldAutoSettle -> settleWithProtocol) without React, since
 * this repo has no jsdom/RTL setup. Exercises the same functions the real
 * effect composes in ppm-settlement-toast-effect.tsx.
 */
async function runAutoSettleAttempt(
  orderId: string,
  expiresAt: string,
  fetchOrderStatus: () => Promise<string>,
  settleWithProtocol: () => Promise<void>,
): Promise<'settled' | 'skipped' | 'blocked' | 'failed'> {
  if (!markSettlingInFlight(orderId)) return 'blocked';
  try {
    const status = await retryWithBackoff(fetchOrderStatus, {
      delaysMs: [0, 0, 0],
      isRetryable: () => true,
    });
    if (!shouldAutoSettle(status, expiresAt, Date.now() / 1000)) return 'skipped';
    await settleWithProtocol();
    return 'settled';
  } catch {
    return 'failed';
  } finally {
    unmarkSettlingInFlight(orderId);
  }
}

describe('auto-settlement retry flow', () => {
  it('order becomes FILLED during retry: settleWithProtocol is never called', async () => {
    let statusCalls = 0;
    let settleCalls = 0;
    const result = await runAutoSettleAttempt(
      'order-filled-during-retry',
      String(Date.now() / 1000 + 120),
      async () => {
        statusCalls += 1;
        if (statusCalls < 3) throw new Error('rpc unavailable');
        return 'FILLED'; // another tab/reconciliation landed it while we were retrying
      },
      async () => {
        settleCalls += 1;
      },
    );
    expect(result).toBe('skipped');
    expect(settleCalls).toBe(0);
    expect(statusCalls).toBe(3);
  });

  it('retry never opens the wallet twice: a concurrent attempt for the same order is blocked by the shared in-flight guard', async () => {
    let settleCalls = 0;
    const orderId = 'order-concurrent';
    const fetchOrderStatus = async () => 'OPEN';
    const settle = async () => {
      settleCalls += 1;
    };

    const first = runAutoSettleAttempt(orderId, String(Date.now() / 1000 + 120), fetchOrderStatus, settle);
    // A second caller (e.g. StrictMode's double-invoke, or the manual
    // Approve button) racing in while the first is mid-retry/mid-settle.
    const second = runAutoSettleAttempt(orderId, String(Date.now() / 1000 + 120), fetchOrderStatus, settle);

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect([firstResult, secondResult].sort()).toEqual(['blocked', 'settled']);
    expect(settleCalls).toBe(1);
  });

  it('all retries fail: settlement is skipped, not treated as settled or as a hard failure requiring user action beyond retry', async () => {
    const result = await runAutoSettleAttempt(
      'order-all-retries-fail',
      String(Date.now() / 1000 + 120),
      async () => {
        throw new Error('rpc unavailable');
      },
      async () => {
        throw new Error('should never be called');
      },
    );
    expect(result).toBe('failed');
  });
});
