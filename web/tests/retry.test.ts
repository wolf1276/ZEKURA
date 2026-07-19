import { describe, expect, it, vi } from 'vitest';
import { retryWithBackoff, CancelledError } from '../src/lib/retry';

const alwaysRetryable = () => true;
const neverRetryable = () => false;

describe('retryWithBackoff', () => {
  it('first request fails, second succeeds: returns the second result without exhausting retries', async () => {
    let calls = 0;
    const result = await retryWithBackoff(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error('transient');
        return 'ok';
      },
      { delaysMs: [0, 0, 0], isRetryable: alwaysRetryable },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('all retries fail: throws the last error after exactly 1 + delaysMs.length calls', async () => {
    let calls = 0;
    await expect(
      retryWithBackoff(
        async () => {
          calls += 1;
          throw new Error(`fail-${calls}`);
        },
        { delaysMs: [0, 0, 0], isRetryable: alwaysRetryable },
      ),
    ).rejects.toThrow('fail-4');
    expect(calls).toBe(4);
  });

  it('does not retry a non-retryable failure', async () => {
    let calls = 0;
    await expect(
      retryWithBackoff(
        async () => {
          calls += 1;
          throw new Error('order not found');
        },
        { delaysMs: [0, 0, 0], isRetryable: neverRetryable },
      ),
    ).rejects.toThrow('order not found');
    expect(calls).toBe(1);
  });

  it('stops immediately if cancelled before the next attempt, without making another call', async () => {
    let calls = 0;
    let cancelled = false;
    const promise = retryWithBackoff(
      async () => {
        calls += 1;
        cancelled = true; // simulate unmount happening right after the first attempt fails
        throw new Error('transient');
      },
      { delaysMs: [0, 0, 0], isRetryable: alwaysRetryable, isCancelled: () => cancelled },
    );
    await expect(promise).rejects.toBeInstanceOf(CancelledError);
    expect(calls).toBe(1);
  });

  it('honors increasing backoff delays between attempts', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const promise = retryWithBackoff(
        async () => {
          calls += 1;
          if (calls < 3) throw new Error('transient');
          return 'ok';
        },
        { delaysMs: [500, 1000, 2000], isRetryable: alwaysRetryable },
      );

      await vi.advanceTimersByTimeAsync(500);
      expect(calls).toBe(2);
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls).toBe(3);

      await expect(promise).resolves.toBe('ok');
    } finally {
      vi.useRealTimers();
    }
  });
});
