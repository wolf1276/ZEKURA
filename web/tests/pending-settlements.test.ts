import { describe, expect, it } from 'vitest';
import { shouldAutoSettle } from '../src/services/midnight/pendingSettlements';

// shouldAutoSettle gates the auto-settlement effect's decision to fire
// settleWithProtocol against a freshly-fetched (not localStorage-cached)
// order status — this is what protects against a page refresh re-firing a
// settlement that already landed. Each case below maps to a refresh point
// in that flow.
describe('shouldAutoSettle', () => {
  const now = 1_000_000;

  it('refresh before the wallet popup ever opened: order is still OPEN, quote live — allowed', () => {
    expect(shouldAutoSettle('OPEN', String(now + 60), now)).toBe(true);
  });

  it('refresh while the wallet popup is open: no tx has landed yet, order still OPEN — allowed', () => {
    expect(shouldAutoSettle('OPEN', String(now + 60), now)).toBe(true);
  });

  it('refresh after the tx was submitted but before WS/reconciliation caught up: order is SETTLING — blocked', () => {
    expect(shouldAutoSettle('SETTLING', String(now + 60), now)).toBe(false);
  });

  it('refresh after the order was already reconciled to FILLED — blocked', () => {
    expect(shouldAutoSettle('FILLED', String(now + 60), now)).toBe(false);
  });

  it('refresh after the quote expired: order still OPEN but expiresAt has passed — blocked', () => {
    expect(shouldAutoSettle('OPEN', String(now - 1), now)).toBe(false);
  });
});
