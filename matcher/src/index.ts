/**
 * Composition root. This is the only file in the Matcher that wires real
 * Midnight SDK providers, a live wallet, and a connection to the
 * already-deployed exchange contract — everything it constructs (providers,
 * findDeployedContract, the witnesses closure) mirrors the exact pattern
 * already used and confirmed working in ../../src/cli.ts and
 * ../../src/deploy.ts. Every other module in this package is unit-tested
 * without ever importing this file.
 */
import { Buffer } from 'node:buffer';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import Fastify from 'fastify';

import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { WebSocket } from 'ws';

import type { Contract as ExchangeContract } from '../../contracts/managed/exchange/contract/index.js';
import { getDeployment, getOrCreateAdminSecret, getOrCreateSeed, resolveNetwork } from '../../src/network.js';
import { createWallet, persistWalletState, unshieldedToken } from '../../src/wallet.js';
import { AdminAuth } from './api/middleware/adminAuth.js';
import { buildApp } from './app.js';
import { MatchRepository } from './db/repositories/MatchRepository.js';
import { OrderRepository } from './db/repositories/OrderRepository.js';
import { ReservationRepository } from './db/repositories/ReservationRepository.js';
import { TreasuryRepository } from './db/repositories/TreasuryRepository.js';
import { openDatabase } from './db/sqlite.js';
import { MatchingEngine } from './matcher/MatchingEngine.js';
import { PriceTimePriorityStrategy } from './matcher/MatchingStrategy.js';
import { OrderBook } from './orderbook/OrderBook.js';
import { DEFAULT_PRICING_CONFIG, PricingEngine } from './ppm/PricingEngine.js';
import { PPMService } from './ppm/PPMService.js';
import {
  TreasuryClient,
  type EitherAddressValue,
  type OnChainReservationReader,
  type OnChainReservationState,
  type OnChainTreasuryReader,
  type PpmCircuitCaller,
} from './ppm/TreasuryClient.js';
import { MarketDataService } from './services/MarketDataService.js';
import { OrderService } from './services/OrderService.js';
import { SettlementService } from './services/SettlementService.js';
import {
  buildExchangeWitnesses,
  SettlementClient,
  type OnChainOrderRecord,
  type OnChainOrderState,
  type OnChainOrderReader,
  type SettleCircuitCaller,
} from './settlement/SettlementClient.js';
import { SettlementQueue } from './settlement/SettlementQueue.js';
import type { Hex32 } from './types/Asset.js';
import { loadConfig } from './utils/config.js';
import { bytes32ToHex, hexToBytes32 } from './utils/hex.js';
import { createLogger } from './utils/logger.js';
import type { Broadcaster, MatcherEventType } from './websocket/SocketServer.js';
import { SocketServer } from './websocket/SocketServer.js';

// Required for wallet sync over the indexer's GraphQL websocket — same as
// ../../src/deploy.ts / ../../src/cli.ts / ../../scripts/e2e-check.ts.
// @ts-expect-error Required for wallet sync
globalThis.WebSocket = WebSocket;

/**
 * Locates the zekura repo root by walking up from this file's own directory
 * until `contracts/exchange.compact` is found. Deliberately NOT a fixed
 * `path.resolve(__dirname, '..', '..')` hop count: this file's on-disk
 * depth relative to the repo root differs between `tsx` (runs directly from
 * matcher/src/, 2 levels down) and the compiled build (lands at
 * matcher/dist/matcher/src/, 4 levels down — see README.md's build-output
 * note, a consequence of index.ts importing ../../src/wallet.ts across the
 * package boundary). A fixed hop count is only ever correct for one of the
 * two, so the search below is used instead of __dirname arithmetic for
 * every filesystem path derived from the repo root (zkConfigPath, and the
 * cwd passed to resolveNetwork/getDeployment/getOrCreateSeed/createWallet).
 */
function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (fs.existsSync(path.join(dir, 'contracts', 'exchange.compact'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`Could not locate the zekura repo root (contracts/exchange.compact) above ${startDir}`);
    }
    dir = parent;
  }
}

/**
 * Binds `config.port`/`config.host` immediately, before wallet sync or any
 * other slow startup work runs. Without this, nothing listens on the port
 * until `main()` reaches the real `app.listen()` near the bottom — on a
 * platform like Railway that proxies to the port and health-checks it, a
 * from-genesis wallet sync (which can run for a long time on first boot)
 * means the whole window looks like a crashed/unresponsive deploy from the
 * outside, even though the process is healthy and actively syncing. Every
 * request gets a fast, honest 503 instead of a proxy-level connection
 * failure. Closed and replaced by the real app once startup finishes.
 */
async function startBootstrapServer(config: ReturnType<typeof loadConfig>) {
  const bootstrap = Fastify({ logger: false });
  bootstrap.get('/health', async () => ({ status: 'syncing' }));
  bootstrap.setNotFoundHandler((_request, reply) => {
    reply.code(503).send({ error: 'SYNCING', message: 'Matcher is starting up (wallet sync in progress); try again shortly.' });
  });
  await bootstrap.listen({ port: config.port, host: config.host });
  return bootstrap;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger('matcher', { level: config.logLevel, pretty: config.prettyLogs });
  const bootstrap = await startBootstrapServer(config);
  logger.info({ port: config.port, host: config.host }, 'bootstrap server listening (syncing wallet next)');

  const repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));

  const { network, config: networkConfig } = resolveNetwork({ cwd: repoRoot });
  const deployment = getDeployment(network, { cwd: repoRoot });
  if (!deployment) {
    logger.error({ network }, 'No contract deployment recorded for this network — run `npm run setup` in the repo root first');
    process.exit(1);
  }

  const zkConfigPath = path.join(repoRoot, 'contracts', 'managed', 'exchange');
  const contractPath = path.join(zkConfigPath, 'contract', 'index.js');
  if (!fs.existsSync(contractPath)) {
    logger.error('Contract not compiled — run `npm run compile` in the repo root first');
    process.exit(1);
  }
  const Exchange = await import(pathToFileURL(contractPath).href);

  const db = openDatabase(config.dbPath);
  const orderRepo = new OrderRepository(db);
  const matchRepo = new MatchRepository(db);

  const seed = process.env[config.matcherSeedEnvVar]?.trim() || getOrCreateSeed(network, { cwd: repoRoot });
  logger.info({ network }, 'syncing matcher operator wallet');
  const walletCtx = await createWallet({ network, networkConfig, seed, cwd: repoRoot });
  const walletState = await walletCtx.wallet.waitForSyncedState();
  await persistWalletState(network, walletCtx, repoRoot);
  logger.info(
    { balance: (walletState.unshielded.balances[unshieldedToken().raw] ?? 0n).toString() },
    'matcher operator wallet synced',
  );

  const privateStatePassword = process.env.PRIVATE_STATE_PASSWORD?.trim() || 'Local-Devnet-Development-Placeholder-1';
  const walletProvider = {
    getCoinPublicKey: () => walletState.shielded.coinPublicKey.toHexString(),
    getEncryptionPublicKey: () => walletState.shielded.encryptionPublicKey.toHexString(),
    async balanceTx(tx: unknown, ttl?: Date) {
      const recipe = await walletCtx.wallet.balanceUnboundTransaction(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tx as any,
        { shieldedSecretKeys: walletCtx.shieldedSecretKeys, dustSecretKey: walletCtx.dustSecretKey },
        { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000) },
      );
      const signedRecipe = await walletCtx.wallet.signRecipe(recipe, (payload) =>
        walletCtx.unshieldedKeystore.signData(payload),
      );
      return walletCtx.wallet.finalizeRecipe(signedRecipe);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    submitTx: (tx: unknown) => walletCtx.wallet.submitTransaction(tx as any) as any,
  };

  const zkConfigProvider = new NodeZkConfigProvider(zkConfigPath);
  const accountId = walletCtx.unshieldedKeystore.getBech32Address().toString();
  const providers = {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: 'matcher-exchange-state',
      accountId,
      privateStoragePasswordProvider: () => privateStatePassword,
    }),
    publicDataProvider: indexerPublicDataProvider(networkConfig.indexer, networkConfig.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(networkConfig.proofServer, zkConfigProvider),
    walletProvider,
    midnightProvider: walletProvider,
  };

  // The witnesses close over orderRepo directly: settle() looks up
  // whichever orderId it's given (buy or sell side of whatever pair is
  // being settled) at call time, so one shared witnesses object serves
  // every settle() call for the life of the process — see
  // settlement/SettlementClient.ts's doc comment.
  //
  // getOrCreateAdminSecret resolves TREASURY_ADMIN_SECRET first, then the
  // same per-network secret persisted by `npm run deploy` in
  // .midnight-state.json — so by default the Matcher submits admin-gated
  // Treasury transactions as the same identity that bootstrapped the
  // Treasury at deploy time. Set TREASURY_ADMIN_SECRET explicitly on
  // preview/preprod rather than relying on the local state file.
  const treasuryAdminSecretHex = getOrCreateAdminSecret(network, { cwd: repoRoot });
  const witnesses = buildExchangeWitnesses({ findById: (id) => orderRepo.findById(id) }, treasuryAdminSecretHex);
  const compiledContractBase = CompiledContract.make<ExchangeContract<undefined>>('exchange', Exchange.Contract);
  const compiledContractWithWitnesses = CompiledContract.withWitnesses(compiledContractBase, witnesses);
  const compiledContract = CompiledContract.withCompiledFileAssets(compiledContractWithWitnesses, zkConfigPath);

  logger.info({ contractAddress: deployment.address }, 'connecting to deployed exchange contract');
  // The dynamically-imported contract module is typed `any`; the `as any` here mirrors the
  // exact same cast already used in ../../src/cli.ts and ../../src/deploy.ts for this reason.
  const foundContract = await findDeployedContract(providers, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    compiledContract: compiledContract as any,
    contractAddress: deployment.address,
  });

  const onChainReader: OnChainOrderReader = {
    async getOrder(orderId: string): Promise<OnChainOrderRecord> {
      const contractState = await providers.publicDataProvider.queryContractState(deployment.address);
      if (!contractState) return { state: 'NOT_FOUND', commitment: null };
      const ledgerState = Exchange.ledger(contractState.data);
      const idBytes = Buffer.from(orderId, 'hex');
      if (!ledgerState.orders.member(idBytes)) return { state: 'NOT_FOUND', commitment: null };
      const record = ledgerState.orders.lookup(idBytes);
      const state = Exchange.OrderState[record.state] as OnChainOrderState;
      return { state, commitment: Buffer.from(record.commitment).toString('hex') };
    },
  };

  const settleCaller: SettleCircuitCaller = {
    async settle(buyOrderId: Uint8Array, sellOrderId: Uint8Array) {
      const tx = await foundContract.callTx.settle(buyOrderId, sellOrderId);
      return { public: { txId: String(tx.public.txId) } };
    },
  };

  const treasuryReader: OnChainTreasuryReader = {
    async getLiquidity(assetKey: Hex32) {
      const contractState = await providers.publicDataProvider.queryContractState(deployment.address);
      if (!contractState) return { balance: 0n, reserved: 0n, available: 0n };
      const ledgerState = Exchange.ledger(contractState.data);
      const keyBytes = hexToBytes32(assetKey);
      const balance: bigint = ledgerState.treasuryBalances.member(keyBytes) ? ledgerState.treasuryBalances.lookup(keyBytes) : 0n;
      const reserved: bigint = ledgerState.treasuryReserved.member(keyBytes) ? ledgerState.treasuryReserved.lookup(keyBytes) : 0n;
      return { balance, reserved, available: balance - reserved };
    },
  };

  const reservationReader: OnChainReservationReader = {
    async getReservationState(quoteId: Hex32): Promise<OnChainReservationState> {
      const contractState = await providers.publicDataProvider.queryContractState(deployment.address);
      if (!contractState) return 'NOT_FOUND';
      const ledgerState = Exchange.ledger(contractState.data);
      const idBytes = hexToBytes32(quoteId);
      if (!ledgerState.reservations.member(idBytes)) return 'NOT_FOUND';
      const record = ledgerState.reservations.lookup(idBytes);
      return Exchange.ReservationState[record.state] as OnChainReservationState;
    },
  };

  const ppmCaller: PpmCircuitCaller = {
    async reserveLiquidity(quoteId, assetKey, amount, price, expiresAt) {
      const tx = await foundContract.callTx.reserveLiquidity(quoteId, assetKey, amount, price, expiresAt);
      return { public: { txId: String(tx.public.txId) } };
    },
    async releaseLiquidity(quoteId) {
      const tx = await foundContract.callTx.releaseLiquidity(quoteId);
      return { public: { txId: String(tx.public.txId) } };
    },
    async releaseExpiredLiquidity(quoteId) {
      const tx = await foundContract.callTx.releaseExpiredLiquidity(quoteId);
      return { public: { txId: String(tx.public.txId) } };
    },
    async settleWithProtocol(orderId, quoteId, recipient) {
      const tx = await foundContract.callTx.settleWithProtocol(orderId, quoteId, recipient);
      return { public: { txId: String(tx.public.txId) } };
    },
    async depositTreasury(assetKey, amount) {
      const tx = await foundContract.callTx.depositTreasury(assetKey, amount);
      return { public: { txId: String(tx.public.txId) } };
    },
    async withdrawTreasury(assetKey, amount, recipient: EitherAddressValue) {
      const tx = await foundContract.callTx.withdrawTreasury(assetKey, amount, recipient);
      return { public: { txId: String(tx.public.txId) } };
    },
  };

  const orderBook = new OrderBook();
  const matchingEngine = new MatchingEngine(orderBook, new PriceTimePriorityStrategy());
  const settlementClient = new SettlementClient(settleCaller, onChainReader, logger);
  const settlementQueue = new SettlementQueue(config.settlement, logger);
  const treasuryClient = new TreasuryClient(ppmCaller, treasuryReader, logger);
  const reservationRepo = new ReservationRepository(db);
  const treasuryRepo = new TreasuryRepository(db);
  const pricingConfig = DEFAULT_PRICING_CONFIG;
  const STATS_WINDOW_MS = 24 * 60 * 60 * 1000;

  // Three forward references break what would otherwise be a cycle:
  // OrderService optionally depends on PPMService, which depends on
  // MarketDataService, which reads OrderService's own orderbook/stats
  // methods — plus the pre-existing OrderService <-> SocketServer <-> Fastify
  // app and OrderService <-> SettlementService cycles. All of these are only
  // ever *invoked* during request/settlement/PPM handling, long after every
  // object below has finished being constructed, so a closure over a
  // not-yet-assigned `let` is sufficient for each — no event emitter or DI
  // container needed.
  // eslint-disable-next-line prefer-const -- assigned once, later; must stay `let` for the closures above to observe it
  let socketServer: SocketServer | undefined;
  const broadcaster: Broadcaster = {
    broadcast: <T>(type: MatcherEventType, payload: T) => socketServer?.broadcast(type, payload),
  };
  // eslint-disable-next-line prefer-const -- assigned once, later; must stay `let` for the closure above to observe it
  let settlementService: SettlementService | undefined;
  // eslint-disable-next-line prefer-const -- assigned once, later; must stay `let` for the closures below to observe it
  let orderServiceRef: OrderService | undefined;

  const marketDataService = new MarketDataService({
    getOrderBookSnapshot: (asset) => orderServiceRef!.getOrderBookSnapshot(asset),
    getMarketStats: (asset, windowMs) => orderServiceRef!.getMarketStats(asset, windowMs),
    treasuryClient,
  });
  const pricingEngine = new PricingEngine(pricingConfig);
  const ppmService = new PPMService({
    marketDataService,
    pricingEngine,
    treasuryClient,
    reservationRepo,
    treasuryRepo,
    broadcaster,
    logger,
    statsWindowMs: STATS_WINDOW_MS,
  });

  const orderService = new OrderService({
    db,
    orderRepo,
    matchRepo,
    orderBook,
    matchingEngine,
    onChainReader,
    broadcaster,
    logger,
    onMatch: (match) => settlementService?.handleMatch(match),
    ppmService,
    reservationRepo,
    reservationReader,
  });
  orderServiceRef = orderService;

  settlementService = new SettlementService({
    db,
    orderRepo,
    matchRepo,
    settlementClient,
    queue: settlementQueue,
    broadcaster,
    logger,
  });

  // The same secret buildExchangeWitnesses' adminSecretKey witness uses —
  // this is the ONE on-chain admin identity every admin-gated circuit call
  // is actually authorized under, regardless of which allowlisted HTTP
  // caller triggered it (see api/admin.ts's AdminRoutesDeps doc comment).
  const onChainAdminActorId = bytes32ToHex(Exchange.pureCircuits.deriveAdminId(Buffer.from(treasuryAdminSecretHex, 'hex')));
  const adminAuth = new AdminAuth({ allowedAddresses: config.adminAddresses });
  if (config.adminAddresses.size === 0) {
    logger.warn('MATCHER_ADMIN_ADDRESSES is empty — no wallet is authorized to use the admin Treasury endpoints');
  }

  const app = buildApp({
    orderService,
    treasury: { treasuryClient, treasuryRepo, pricingConfig },
    admin: { adminAuth, treasuryClient, treasuryRepo, broadcaster, logger, onChainAdminActorId },
    logger: true,
  });
  socketServer = new SocketServer(app.server, logger);

  const recovered = settlementService.recoverPendingSettlements();
  if (recovered > 0) {
    logger.info({ recovered }, 'recovered in-flight settlements from a previous run');
  }

  // Proactively reclaims expired-but-unswept PPM reservations — defense in
  // depth alongside releaseExpiredLiquidity's own on-chain permissionless
  // callability (see contracts/exchange.compact and ppm/PPMService.ts).
  const EXPIRY_SWEEP_INTERVAL_MS = 60_000;
  const expirySweepInterval = setInterval(() => {
    ppmService.sweepExpiredReservations().catch((error) => logger.error({ error }, 'PPM expiry sweep failed'));
    // Closed-tab safety net: reconcile any pending protocol fill whose
    // user-submitted settleWithProtocol has landed on-chain but whose owning
    // session never re-fetched GET /orders/:id to trigger the lazy path.
    orderService
      .reconcileAllPendingProtocolFills()
      .then((n) => {
        if (n > 0) logger.info({ materialized: n }, 'reconciled executed PPM reservations from the periodic sweep');
      })
      .catch((error) => logger.error({ error }, 'PPM reconcile sweep failed'));
  }, EXPIRY_SWEEP_INTERVAL_MS);
  expirySweepInterval.unref();

  await bootstrap.close();
  await app.listen({ port: config.port, host: config.host });
  logger.info({ port: config.port, host: config.host }, 'matcher server listening');

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    await socketServer?.close();
    await app.close();
    await walletCtx.wallet.stop();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
