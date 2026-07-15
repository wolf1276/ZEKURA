import { describe, expect, it, vi } from 'vitest';

import { SettlementQueue } from '../../src/settlement/SettlementQueue.js';
import { createLogger } from '../../src/utils/logger.js';

const logger = createLogger('test', { level: 'silent' });

describe('SettlementQueue', () => {
  it('runs a job to completion on the first attempt', async () => {
    const queue = new SettlementQueue({ maxRetries: 3, retryDelayMs: 1 }, logger);
    const job = vi.fn().mockResolvedValue('done' as const);
    queue.enqueue('key-1', job);
    await vi.waitFor(() => expect(queue.isInFlight('key-1')).toBe(false));
    expect(job).toHaveBeenCalledTimes(1);
    expect(job).toHaveBeenCalledWith(1, 4); // maxAttempts = maxRetries + 1
  });

  it('retries on "retry" outcome up to the retry budget, then stops', async () => {
    const queue = new SettlementQueue({ maxRetries: 2, retryDelayMs: 1 }, logger);
    const job = vi.fn().mockResolvedValue('retry' as const);
    queue.enqueue('key-1', job);
    await vi.waitFor(() => expect(queue.isInFlight('key-1')).toBe(false), { timeout: 2000 });
    expect(job).toHaveBeenCalledTimes(3); // maxRetries(2) + 1 initial attempt
  });

  it('stops retrying as soon as a job returns "done"', async () => {
    const queue = new SettlementQueue({ maxRetries: 5, retryDelayMs: 1 }, logger);
    let calls = 0;
    const job = vi.fn(async (): Promise<'done' | 'retry'> => {
      calls++;
      return calls === 2 ? 'done' : 'retry';
    });
    queue.enqueue('key-1', job);
    await vi.waitFor(() => expect(queue.isInFlight('key-1')).toBe(false));
    expect(calls).toBe(2);
  });

  it('is single-flight per key: a second enqueue while one is in flight is ignored', async () => {
    const queue = new SettlementQueue({ maxRetries: 0, retryDelayMs: 50 }, logger);
    const job = vi.fn().mockResolvedValue('done' as const);
    queue.enqueue('key-1', job);
    expect(queue.isInFlight('key-1')).toBe(true);
    queue.enqueue('key-1', job); // ignored — job is still running
    await vi.waitFor(() => expect(queue.isInFlight('key-1')).toBe(false));
    expect(job).toHaveBeenCalledTimes(1);
  });

  it('different keys run independently and concurrently', async () => {
    const queue = new SettlementQueue({ maxRetries: 0, retryDelayMs: 1 }, logger);
    const jobA = vi.fn().mockResolvedValue('done' as const);
    const jobB = vi.fn().mockResolvedValue('done' as const);
    queue.enqueue('a', jobA);
    queue.enqueue('b', jobB);
    await vi.waitFor(() => expect(queue.isInFlight('a')).toBe(false));
    await vi.waitFor(() => expect(queue.isInFlight('b')).toBe(false));
    expect(jobA).toHaveBeenCalledTimes(1);
    expect(jobB).toHaveBeenCalledTimes(1);
  });

  it('treats a thrown error from the job as retryable rather than crashing the queue', async () => {
    const queue = new SettlementQueue({ maxRetries: 1, retryDelayMs: 1 }, logger);
    let calls = 0;
    const job = vi.fn(async (): Promise<'done' | 'retry'> => {
      calls++;
      if (calls === 1) throw new Error('boom');
      return 'done';
    });
    queue.enqueue('key-1', job);
    await vi.waitFor(() => expect(queue.isInFlight('key-1')).toBe(false));
    expect(calls).toBe(2);
  });
});
