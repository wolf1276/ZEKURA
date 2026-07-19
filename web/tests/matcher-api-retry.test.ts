import { describe, expect, it } from 'vitest';
import { MatcherApiError, isRetryableMatcherError } from '../src/services/matcher/api';

describe('isRetryableMatcherError', () => {
  it('retries a network-level failure (fetch rejected before any response)', () => {
    expect(isRetryableMatcherError(new TypeError('Failed to fetch'))).toBe(true);
  });

  it('retries a temporary 5xx (Matcher/RPC unavailable)', () => {
    expect(isRetryableMatcherError(new MatcherApiError(503, { error: 'unavailable', message: 'unavailable' }))).toBe(true);
    expect(isRetryableMatcherError(new MatcherApiError(500, { error: 'internal', message: 'internal' }))).toBe(true);
  });

  it('does not retry a 404 (order not found)', () => {
    expect(isRetryableMatcherError(new MatcherApiError(404, { error: 'not_found', message: 'not found' }))).toBe(false);
  });

  it('does not retry a 400 (invalid order state / expired quote)', () => {
    expect(isRetryableMatcherError(new MatcherApiError(400, { error: 'invalid_state', message: 'invalid state' }))).toBe(false);
  });
});
