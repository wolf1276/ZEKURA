/**
 * Order lifecycle. OPEN is the only non-terminal, re-enterable state:
 * MATCHED/SETTLING are transient waypoints toward FILLED, and a failed
 * settlement that finds the on-chain order still OPEN sends it back to
 * OPEN rather than a dead end (see settlement/SettlementQueue.ts).
 */
export type OrderStatus = 'OPEN' | 'MATCHED' | 'SETTLING' | 'FILLED' | 'CANCELLED' | 'EXPIRED' | 'FAILED';

export const ORDER_STATUSES: readonly OrderStatus[] = [
  'OPEN',
  'MATCHED',
  'SETTLING',
  'FILLED',
  'CANCELLED',
  'EXPIRED',
  'FAILED',
] as const;

/** Statuses from which no further transition is possible. */
export const TERMINAL_STATUSES: ReadonlySet<OrderStatus> = new Set(['FILLED', 'CANCELLED', 'EXPIRED', 'FAILED']);

export function isTerminalStatus(status: OrderStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function isOrderStatus(value: unknown): value is OrderStatus {
  return typeof value === 'string' && (ORDER_STATUSES as readonly string[]).includes(value);
}
