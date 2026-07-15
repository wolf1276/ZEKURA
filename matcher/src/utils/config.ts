/**
 * Matcher-specific runtime configuration. Chain network/wallet configuration
 * (which network, node/indexer/proof-server URLs, contract address) is
 * intentionally NOT duplicated here — it's owned by the root project's
 * src/network.ts (resolveNetwork/getDeployment), which index.ts and
 * SettlementClient consume directly. This module only covers settings that
 * are specific to running the Matcher service itself.
 */
export interface MatcherConfig {
  readonly port: number;
  readonly host: string;
  readonly dbPath: string;
  readonly logLevel: string;
  readonly prettyLogs: boolean;
  readonly settlement: {
    readonly maxRetries: number;
    readonly retryDelayMs: number;
  };
  /**
   * Env var name holding the Matcher's own operator wallet seed. Falls back
   * to the root project's per-network seed (src/network.ts's
   * getOrCreateSeed) when unset — fine for local devnet, but a distinct
   * funded operator wallet is expected on preview/preprod. See MATCHER.md.
   */
  readonly matcherSeedEnvVar: string;
}

function parseIntEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) {
    throw new Error(`Invalid integer environment value: "${value}"`);
  }
  return parsed;
}

function parseBoolEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return value.trim().toLowerCase() === 'true' || value.trim() === '1';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MatcherConfig {
  return {
    port: parseIntEnv(env.MATCHER_PORT, 4000),
    host: env.MATCHER_HOST?.trim() || '0.0.0.0',
    dbPath: env.MATCHER_DB_PATH?.trim() || './data/matcher.db',
    logLevel: env.MATCHER_LOG_LEVEL?.trim() || 'info',
    prettyLogs: parseBoolEnv(env.MATCHER_PRETTY_LOGS, env.NODE_ENV !== 'production'),
    settlement: {
      maxRetries: parseIntEnv(env.MATCHER_SETTLEMENT_MAX_RETRIES, 5),
      retryDelayMs: parseIntEnv(env.MATCHER_SETTLEMENT_RETRY_DELAY_MS, 5000),
    },
    matcherSeedEnvVar: 'MATCHER_WALLET_SEED',
  };
}
