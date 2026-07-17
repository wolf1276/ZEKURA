/**
 * End-to-end smoke check for the Zekura exchange contract.
 *
 * Reconnects to the deployed contract, reads its ledger state, and exits 0
 * on success. Used by `npm run test:e2e` and by the project's CI workflows.
 *
 * Requires a successful `npm run deploy` first. As of the Treasury module's
 * addition, `npm run deploy` against the local `undeployed` devnet preset
 * (docker-compose's `node` service, CFG_PRESET=dev) can fail with "Invalid
 * Transaction: Transaction would exhaust the block limits" — the contract
 * now compiles to 13 circuits, and this preset's block-weight limit is too
 * small for the full deploy transaction (proving-key generation, the
 * simulator suite in tests/exchange.test.ts and tests/treasury.test.ts, and
 * TypeScript compilation all still succeed regardless — this is strictly a
 * deploy-transaction capacity limit on this one local preset, not a
 * contract-correctness issue). Compiling with `--no-communications-commitment`
 * does shrink the deploy transaction enough to fit, but was found to make
 * every circuit's real on-chain proof fail verification (`Malformed
 * MalformedError::InvalidProof`, confirmed against both a new Treasury
 * circuit and the pre-existing unmodified createOrder) — do not use that
 * flag as a workaround. Deploy to `preview`/`preprod` (real block-weight
 * limits) to exercise this check for real, or reduce the contract's exported
 * circuit count further.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as nodeCrypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';

import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { resolveNetwork, getOrCreateSeed, getOrCreateAdminSecret, getDeployment } from '../src/network';
import { createWallet, persistWalletState, unshieldedToken } from '../src/wallet';
import { encodeUserAddress } from '@midnight-ntwrk/ledger-v8';
import { encodeRawTokenType } from '@midnight-ntwrk/compact-runtime';
import { getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { MidnightBech32m, UnshieldedAddress } from '@midnight-ntwrk/wallet-sdk-address-format';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import type { Contract as ExchangeContract } from '../contracts/managed/exchange/contract/index.js';

// @ts-expect-error wallet sync requires WebSocket
globalThis.WebSocket = WebSocket;

// ─── Network configuration ─────────────────────────────────────────────────────

const { network, config: networkConfig } = resolveNetwork();
const SEED = getOrCreateSeed(network);

function fail(msg: string): never {
  console.error(`❌ e2e-check failed: ${msg}`);
  process.exit(1);
}

function isHexAddress(s: unknown): s is string {
  return typeof s === 'string' && /^[0-9a-fA-F]+$/.test(s) && s.length >= 32;
}

async function main() {
  // 1. Deployment sanity
  const deployment = getDeployment(network);
  if (!deployment) {
    console.error(`No deploy on file for network ${network}.`);
    process.exit(1);
  }
  if (!isHexAddress(deployment.address)) {
    fail(`Deployment address missing or invalid: ${JSON.stringify(deployment, null, 2)}`);
  }

  // 2. Build wallet and providers
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const zkConfigPath = path.resolve(__dirname, '..', 'contracts', 'managed', 'exchange');
  const contractPath = path.join(zkConfigPath, 'contract', 'index.js');
  if (!fs.existsSync(contractPath)) fail('Compiled contract missing — run `npm run compile`.');
  const Exchange = await import(pathToFileURL(contractPath).href);
  // orderDetails/orderBlinding/ownerSecretKey stay unimplemented — this
  // check never touches an order. adminSecretKey is real: the Treasury pass
  // below submits real depositTreasury/reserveLiquidity/releaseLiquidity/
  // withdrawTreasury transactions, and the wallet running this check is the
  // network's bootstrap admin (see deploy.ts/getOrCreateAdminSecret).
  const adminSecretHex = getOrCreateAdminSecret(network);
  const exchangeWitnesses = {
    orderDetails: () => {
      throw new Error('orderDetails witness not implemented in e2e-check.ts (this check never touches an order).');
    },
    orderBlinding: () => {
      throw new Error('orderBlinding witness not implemented in e2e-check.ts (this check never touches an order).');
    },
    ownerSecretKey: () => {
      throw new Error('ownerSecretKey witness not implemented in e2e-check.ts (this check never touches an order).');
    },
    adminSecretKey: (context: any) => [context.privateState, Buffer.from(adminSecretHex, 'hex')],
  };
  // Dynamic import makes Exchange.Contract's inferred type `any`; supplying
  // the real generated Contract type as an explicit type argument keeps
  // compact-js's generic inference for withWitnesses working despite that.
  const compiledContractBase = CompiledContract.make<ExchangeContract<undefined>>('exchange', Exchange.Contract);
  const compiledContractWithWitnesses = CompiledContract.withWitnesses(compiledContractBase, exchangeWitnesses);
  const compiledContract = CompiledContract.withCompiledFileAssets(compiledContractWithWitnesses, zkConfigPath);

  const walletCtx = await createWallet({ network, networkConfig, seed: SEED });
  const state = await walletCtx.wallet.waitForSyncedState();
  // Persist the sync state — saves time on the next e2e-check invocation in CI
  // when run against the same persistent wallet directory.
  await persistWalletState(network, walletCtx);

  const zkConfigProvider = new NodeZkConfigProvider(zkConfigPath);
  const walletProvider = {
    getCoinPublicKey: () => state.shielded.coinPublicKey.toHexString(),
    getEncryptionPublicKey: () => state.shielded.encryptionPublicKey.toHexString(),
    // Real implementation (mirrors src/deploy.ts's createProviders) — the
    // Treasury pass below submits real transactions, so this can no longer
    // be a read-only stub.
    async balanceTx(tx: any, ttl?: Date) {
      const recipe = await walletCtx.wallet.balanceUnboundTransaction(
        tx,
        { shieldedSecretKeys: walletCtx.shieldedSecretKeys, dustSecretKey: walletCtx.dustSecretKey },
        { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000) },
      );
      const signedRecipe = await walletCtx.wallet.signRecipe(recipe, (payload) =>
        walletCtx.unshieldedKeystore.signData(payload),
      );
      return walletCtx.wallet.finalizeRecipe(signedRecipe);
    },
    submitTx: (tx: any) => walletCtx.wallet.submitTransaction(tx) as any,
  } as any;

  const providers = {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: 'exchange-state',
      accountId: walletCtx.unshieldedKeystore.getBech32Address().toString(),
      // SDK requires ≥16 chars. No env-var override here — match the deploy
      // script's local-devnet default.
      privateStoragePasswordProvider: () => 'Local-Devnet-Development-Placeholder-1',
    }),
    publicDataProvider: indexerPublicDataProvider(networkConfig.indexer, networkConfig.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(networkConfig.proofServer, zkConfigProvider),
    walletProvider,
    midnightProvider: walletProvider,
  };

  // 3. Reconnect to the deployed contract — proves callTx interface is wired
  let foundContract: any;
  try {
    foundContract = await findDeployedContract(providers, {
      contractAddress: deployment.address,
      compiledContract: compiledContract as any,
    });
  } catch (err: any) {
    await walletCtx.wallet.stop();
    fail(`findDeployedContract threw: ${err?.message ?? err}`);
  }

  // 4. Read the on-chain contract state via the public data provider — proves
  // the contract is indexed and queryable on the chain itself, not just that
  // we know how to construct the local handle.
  const onChainState = await providers.publicDataProvider.queryContractState(deployment.address);
  if (!onChainState) {
    await walletCtx.wallet.stop();
    fail(`queryContractState returned null for ${deployment.address}`);
  }

  function readTreasury(assetKey: Uint8Array) {
    const l = Exchange.ledger(onChainStateRef.data);
    return {
      balance: l.treasuryBalances.member(assetKey) ? l.treasuryBalances.lookup(assetKey) : 0n,
      reserved: l.treasuryReserved.member(assetKey) ? l.treasuryReserved.lookup(assetKey) : 0n,
    };
  }
  let onChainStateRef = onChainState;
  async function refresh() {
    onChainStateRef = await providers.publicDataProvider.queryContractState(deployment.address);
  }

  // 5. Treasury lifecycle — real transactions, not simulated. Proves the
  // Treasury module actually custodies tNIGHT on this deployment, not just
  // that it compiles/simulates correctly (see tests/treasury.test.ts for the
  // simulator-level coverage). Uses a tiny amount relative to the wallet's
  // real balance and nets back out to (near) zero so repeated e2e-check runs
  // don't accumulate state.
  console.log('\n─── Treasury lifecycle (real on-chain transactions) ───────────\n');

  // tNIGHT's real token type on this network, encoded to the Bytes<32> shape
  // Compact's nativeToken()/receiveUnshielded/sendUnshielded expect —
  // unshieldedToken().raw is ledger-v8's hex-string RawTokenType, not the
  // on-chain byte encoding directly.
  const assetKey = encodeRawTokenType(unshieldedToken().raw);
  const DEPOSIT_AMOUNT = 1_000n;
  const RESERVE_AMOUNT = 400n;
  const quoteId = new Uint8Array(nodeCrypto.randomBytes(32));

  const before = readTreasury(assetKey);
  console.log(`  Before:  balance=${before.balance}  reserved=${before.reserved}`);

  console.log('  Submitting depositTreasury...');
  await foundContract.callTx.depositTreasury(assetKey, DEPOSIT_AMOUNT);
  await refresh();
  const afterDeposit = readTreasury(assetKey);
  if (afterDeposit.balance !== before.balance + DEPOSIT_AMOUNT) {
    await walletCtx.wallet.stop();
    fail(`depositTreasury did not move on-chain balance as expected: ${before.balance} -> ${afterDeposit.balance}`);
  }
  console.log(`  ✓ depositTreasury: balance ${before.balance} -> ${afterDeposit.balance}`);

  console.log('  Submitting reserveLiquidity...');
  const farExpiry = BigInt(Math.floor(Date.now() / 1000) + 3600);
  await foundContract.callTx.reserveLiquidity(quoteId, assetKey, RESERVE_AMOUNT, 1n, farExpiry);
  await refresh();
  const afterReserve = readTreasury(assetKey);
  if (afterReserve.reserved !== before.reserved + RESERVE_AMOUNT) {
    await walletCtx.wallet.stop();
    fail(`reserveLiquidity did not move on-chain reserved as expected: got ${afterReserve.reserved}`);
  }
  console.log(`  ✓ reserveLiquidity: reserved ${before.reserved} -> ${afterReserve.reserved}`);

  console.log('  Submitting releaseLiquidity...');
  await foundContract.callTx.releaseLiquidity(quoteId);
  await refresh();
  const afterRelease = readTreasury(assetKey);
  if (afterRelease.reserved !== before.reserved) {
    await walletCtx.wallet.stop();
    fail(`releaseLiquidity did not restore on-chain reserved: got ${afterRelease.reserved}, expected ${before.reserved}`);
  }
  console.log(`  ✓ releaseLiquidity: reserved back to ${afterRelease.reserved}`);

  console.log('  Submitting withdrawTreasury (returning the deposit to this wallet)...');
  // encodeUserAddress expects the hex UserAddress form, not the bech32m
  // string getBech32Address() returns — MidnightBech32m.parse(...).decode(...)
  // is the documented conversion (see @midnight-ntwrk/wallet-sdk-address-format).
  const ownBech32Address = walletCtx.unshieldedKeystore.getBech32Address().toString();
  const ownAddressHex = MidnightBech32m.parse(ownBech32Address).decode(UnshieldedAddress, getNetworkId()).hexString;
  const ownAddressBytes = encodeUserAddress(ownAddressHex);
  const recipient = { is_left: false, left: { bytes: new Uint8Array(32) }, right: { bytes: ownAddressBytes } };
  await foundContract.callTx.withdrawTreasury(assetKey, DEPOSIT_AMOUNT, recipient);
  await refresh();
  const afterWithdraw = readTreasury(assetKey);
  if (afterWithdraw.balance !== before.balance) {
    await walletCtx.wallet.stop();
    fail(`withdrawTreasury did not restore on-chain balance: got ${afterWithdraw.balance}, expected ${before.balance}`);
  }
  console.log(`  ✓ withdrawTreasury: balance back to ${afterWithdraw.balance}\n`);

  console.log(`✅ e2e-check passed`);
  console.log(`   contractAddress: ${deployment.address}`);
  console.log(`   network:         ${network}`);

  await walletCtx.wallet.stop();
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
