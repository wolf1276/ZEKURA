import type { Asset } from './Asset.js';

/**
 * Rolling window stats derived purely from persisted `matches` rows (see
 * db/repositories/MatchRepository.ts) — there is no separate candle/history
 * table; a match already carries everything (price, amount, matchedAt)
 * needed to compute these over any window on read.
 */
export interface MarketStats {
  readonly asset: Asset;
  /** Price of the most recent trade in the window, or null if there were none. */
  readonly lastPrice: bigint | null;
  /** Price of the earliest trade in the window — the baseline `changePct` is computed against. */
  readonly openPrice: bigint | null;
  readonly high: bigint | null;
  readonly low: bigint | null;
  /** Sum of `amount` (base-asset units) across every trade in the window. */
  readonly volumeBase: bigint;
  readonly tradeCount: number;
  /** (lastPrice - openPrice) / openPrice * 100. Null if there were no trades in the window, or openPrice was 0. A float is fine here — this is a display percentage, never a settled balance. */
  readonly changePct: number | null;
}
