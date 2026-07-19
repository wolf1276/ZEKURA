/**
 * Retries `fn` after each failure classified retryable by `isRetryable`,
 * waiting `delaysMs[attempt]` between tries (so `delaysMs.length` is the max
 * number of retries — the initial call plus up to that many retries).
 * Checks `isCancelled` both before the initial call and after each delay, so
 * an unmounted caller never gets a wasted final call or a stale result.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts: {
    delaysMs: number[];
    isRetryable: (err: unknown) => boolean;
    isCancelled?: () => boolean;
  },
): Promise<T> {
  const isCancelled = opts.isCancelled ?? (() => false);
  let attempt = 0;
  for (;;) {
    if (isCancelled()) throw new CancelledError();
    try {
      return await fn();
    } catch (err) {
      const canRetry = attempt < opts.delaysMs.length && opts.isRetryable(err);
      if (!canRetry) throw err;
      await new Promise((resolve) => setTimeout(resolve, opts.delaysMs[attempt]));
      attempt += 1;
    }
  }
}

export class CancelledError extends Error {
  constructor() {
    super("Cancelled");
    this.name = "CancelledError";
  }
}
