import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/utils/config.js';

describe('loadConfig', () => {
  it('applies defaults when no env vars are set', () => {
    const config = loadConfig({});
    expect(config.port).toBe(4000);
    expect(config.host).toBe('0.0.0.0');
    expect(config.dbPath).toBe('./data/matcher.db');
    expect(config.settlement.maxRetries).toBe(5);
    expect(config.settlement.retryDelayMs).toBe(5000);
  });

  it('reads overrides from the given env object', () => {
    const config = loadConfig({
      MATCHER_PORT: '9000',
      MATCHER_HOST: '127.0.0.1',
      MATCHER_DB_PATH: '/tmp/x.db',
      MATCHER_LOG_LEVEL: 'debug',
      MATCHER_PRETTY_LOGS: 'true',
      MATCHER_SETTLEMENT_MAX_RETRIES: '2',
      MATCHER_SETTLEMENT_RETRY_DELAY_MS: '100',
    });
    expect(config.port).toBe(9000);
    expect(config.host).toBe('127.0.0.1');
    expect(config.dbPath).toBe('/tmp/x.db');
    expect(config.logLevel).toBe('debug');
    expect(config.prettyLogs).toBe(true);
    expect(config.settlement.maxRetries).toBe(2);
    expect(config.settlement.retryDelayMs).toBe(100);
  });

  it('defaults prettyLogs to true outside production', () => {
    expect(loadConfig({ NODE_ENV: 'development' }).prettyLogs).toBe(true);
    expect(loadConfig({ NODE_ENV: 'production' }).prettyLogs).toBe(false);
  });

  it('throws on a non-integer numeric env var', () => {
    expect(() => loadConfig({ MATCHER_PORT: 'not-a-number' })).toThrow();
  });
});
