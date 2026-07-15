export type Side = 'BUY' | 'SELL';

export const SIDES: readonly Side[] = ['BUY', 'SELL'] as const;

export function oppositeSide(side: Side): Side {
  return side === 'BUY' ? 'SELL' : 'BUY';
}

export function isSide(value: unknown): value is Side {
  return value === 'BUY' || value === 'SELL';
}
