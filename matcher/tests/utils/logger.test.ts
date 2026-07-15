import { describe, expect, it } from 'vitest';

import { createLogger } from '../../src/utils/logger.js';

describe('createLogger', () => {
  it('creates a working plain (non-pretty) logger', () => {
    const logger = createLogger('test', { level: 'silent' });
    expect(() => logger.info('hello')).not.toThrow();
  });

  it('creates a working pretty logger', () => {
    const logger = createLogger('test', { level: 'silent', pretty: true });
    expect(() => logger.info('hello')).not.toThrow();
  });
});
