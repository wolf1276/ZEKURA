import type { Logger } from '../utils/logger.js';

export type JobOutcome = 'done' | 'retry';

/**
 * One settlement attempt. Receives the 1-based attempt number and the total
 * attempt budget so it can decide, on its own terms, whether a failure on
 * the final attempt should be treated as terminal (e.g. transitioning the
 * match's orders to FAILED) — the queue itself is domain-agnostic and only
 * owns *whether* to retry and how long to wait, never *what* a terminal
 * outcome means. See services/SettlementService.ts for the concrete job.
 */
export type SettlementJob = (attempt: number, maxAttempts: number) => Promise<JobOutcome>;

export interface RetryPolicy {
  readonly maxRetries: number;
  readonly retryDelayMs: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A per-key single-flight async job queue: enqueuing the same key while a
 * job for it is already running is a no-op, which is what prevents a
 * retried settlement from ever racing a freshly triggered one for the same
 * match (see ARCHITECTURE.md's concurrency section). Backoff is linear
 * (retryDelayMs * attempt) — sufficient for the transient failure modes
 * this exists to absorb (proof-server hiccups, brief indexer lag).
 */
export class SettlementQueue {
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly policy: RetryPolicy,
    private readonly logger: Logger,
  ) {}

  enqueue(key: string, job: SettlementJob): void {
    if (this.inFlight.has(key)) {
      this.logger.debug({ key }, 'settlement job already in flight for this key — ignoring duplicate enqueue');
      return;
    }
    this.inFlight.add(key);
    void this.run(key, job).finally(() => this.inFlight.delete(key));
  }

  isInFlight(key: string): boolean {
    return this.inFlight.has(key);
  }

  private async run(key: string, job: SettlementJob): Promise<void> {
    const maxAttempts = this.policy.maxRetries + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let outcome: JobOutcome;
      try {
        outcome = await job(attempt, maxAttempts);
      } catch (error) {
        this.logger.error({ key, attempt, error }, 'settlement job threw unexpectedly — treating as retryable');
        outcome = 'retry';
      }
      if (outcome === 'done') return;
      if (attempt < maxAttempts) {
        await delay(this.policy.retryDelayMs * attempt);
      }
    }
    this.logger.warn({ key, maxAttempts }, 'settlement job exhausted its retry budget without resolving to done');
  }
}
