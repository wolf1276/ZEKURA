import { describe, expect, it } from 'vitest';
import {
  formatAmount,
  formatExpiry,
  formatOrderId,
  formatPercent,
  formatPrice,
  formatRelativeTime,
  truncateAddress,
} from '../src/lib/format';

describe('formatPrice', () => {
  it('formats a number to the requested fixed decimal digits', () => {
    expect(formatPrice(1234.5, 2)).toBe('1,234.50');
  });

  it('accepts a numeric string, matching how order data arrives from the Matcher API', () => {
    expect(formatPrice('900', 0)).toBe('900');
  });
});

describe('formatAmount', () => {
  it('caps fraction digits without padding trailing zeros', () => {
    expect(formatAmount(50, 2)).toBe('50');
    expect(formatAmount(50.125, 2)).toBe('50.13');
  });
});

describe('formatPercent', () => {
  it('prefixes a plus sign for positive values and none for negative', () => {
    expect(formatPercent(3.456, 1)).toBe('+3.5%');
    expect(formatPercent(-2, 1)).toBe('-2.0%');
    expect(formatPercent(0, 1)).toBe('0.0%');
  });
});

describe('truncateAddress', () => {
  it('shortens long addresses to lead...tail', () => {
    const addr = 'mn_addr_preview133whwmeuxs6zs5r0n6ad2sse6q076mk8lggq3y7pl8h4vsywp7zqgwjzmf';
    expect(truncateAddress(addr)).toBe('mn_add...jzmf');
  });

  it('returns short addresses unchanged instead of over-truncating them', () => {
    expect(truncateAddress('short')).toBe('short');
  });
});

describe('formatOrderId', () => {
  it('renders the first 4 hex chars, uppercased, with a # prefix', () => {
    expect(formatOrderId('7e6fb224e13e12736f')).toBe('#7E6F');
  });
});

describe('formatRelativeTime', () => {
  it('renders sub-5-second gaps as "just now"', () => {
    expect(formatRelativeTime(Date.now())).toBe('just now');
  });

  it('renders minute-scale gaps in minutes', () => {
    expect(formatRelativeTime(Date.now() - 5 * 60_000)).toBe('5m ago');
  });
});

describe('formatExpiry', () => {
  it('treats the Uint<64>-max sentinel expiry as GTC, matching the contract-level convention', () => {
    expect(formatExpiry('9999999999')).toBe('GTC');
  });

  it('reports already-passed expiries as "expired"', () => {
    expect(formatExpiry(String(Math.floor(Date.now() / 1000) - 60))).toBe('expired');
  });

  it('renders a future expiry within the hour in minutes', () => {
    const in30min = Math.floor(Date.now() / 1000) + 30 * 60;
    expect(formatExpiry(String(in30min))).toBe('30m');
  });
});
