/**
 * Seeds the redeployed Exchange contract's Treasury with real on-chain
 * liquidity for both sides of the tNIGHT/tZKR pair — NIGHT (nativeToken())
 * and tZKR (contracts/tzkr-token.compact's real minted color, read from
 * .midnight-tzkr.json). Both are real `depositTreasury` transactions,
 * submitted by the network's bootstrap admin wallet (see
 * getOrCreateAdminSecret) — the same identity src/deploy.ts bootstraps as
 * the contract's initial admin.
 *
 * Mirrors scripts/e2e-check.ts's wallet/provider setup (this script submits
 * real transactions the same way that Treasury-lifecycle pass does).
 *
 * Usage: npm run seed:treasury -- --network preprod
 *   [--night <whole-tNIGHT>] [--tzkr <whole-tZKR>]
 * Defaults: 1,000,000 whole tNIGHT, 100,000 whole tZKR (of the 1,000,000
 * minted supply — see src/mint-tzkr.ts).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';

import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { encodeRawTokenType } from '@midnight-ntwrk/compact-runtime';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { resolveNetwork, getOrCreateSeed, getOrCreateAdminSecret, getDeployment } from '../src/network.js';
import { createWallet, persistWalletState, unshieldedToken } from '../src/wallet.js';
import { getTzkrDeployment, TZKR_TOKEN_DECIMALS } from '../src/tzkr-state.js';
import type { Contract as ExchangeContract } from '../contracts/managed/exchange/contract/index.js';

// @ts-expect-error Required for wallet sync
globalThis.WebSocket = WebSocket;

const { network, config: networkConfig } = resolveNetwork();
const SEED = getOrCreateSeed(network);

function parseArg(name: string): string | undefined {
  const argv = process.argv;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === `--${name}`) return argv[i + 1];
    if (argv[i].startsWith(`--${name}=`)) return argv[i].slice(name.length + 3);
  }
  return undefined;
}

async function main() {
  const deployment = getDeployment(network);
  if (!deployment) {
    console.error(`\n❌ No exchange deployment recorded for ${network}. Run: npm run deploy -- --network ${network}\n`);
    process.exit(1);
  }
  const tzkr = getTzkrDeployment(network);
  if (!tzkr?.color) {
    console.error(`\n❌ No tZKR color recorded for ${network}. Run: npm run setup:tzkr -- --network ${network}\n`);
    process.exit(1);
  }
  const tzkrColor = Buffer.from(tzkr.color, 'hex');

  const nightWhole = BigInt(parseArg('night') ?? '1000000');
  const tzkrWhole = BigInt(parseArg('tzkr') ?? '100000');
  const tzkrAmount = tzkrWhole * 10n ** BigInt(TZKR_TOKEN_DECIMALS);

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log(`║  Seed Treasury on ${network}`);
  console.log('╚══════════════════════════════════════════════════════════════╝\n');
  console.log(`  Exchange contract: ${deployment.address}`);
  console.log(`  NIGHT deposit:     ${nightWhole.toLocaleString()}`);
  console.log(`  tZKR deposit:      ${tzkrWhole.toLocaleString()} tZKR (${tzkrAmount.toLocaleString()} base units, color ${tzkr.color})\n`);

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const zkConfigPath = path.resolve(__dirname, '..', 'contracts', 'managed', 'exchange');
  const contractPath = path.join(zkConfigPath, 'contract', 'index.js');
  if (!fs.existsSync(contractPath)) {
    console.error('\n❌ Compiled contract missing — run: npm run compile\n');
    process.exit(1);
  }
  const Exchange = await import(pathToFileURL(contractPath).href);

  const adminSecretHex = getOrCreateAdminSecret(network);
  const exchangeWitnesses = {
    orderDetails: () => { throw new Error('orderDetails witness not implemented (this script never touches an order).'); },
    orderBlinding: () => { throw new Error('orderBlinding witness not implemented (this script never touches an order).'); },
    ownerSecretKey: () => { throw new Error('ownerSecretKey witness not implemented (this script never touches an order).'); },
    adminSecretKey: (context: any) => [context.privateState, Buffer.from(adminSecretHex, 'hex')],
  };
  const compiledContractBase = CompiledContract.make<ExchangeContract<undefined>>('exchange', Exchange.Contract);
  const compiledContractWithWitnesses = CompiledContract.withWitnesses(compiledContractBase, exchangeWitnesses);
  const compiledContract = CompiledContract.withCompiledFileAssets(compiledContractWithWitnesses, zkConfigPath);

  console.log('  Creating + syncing wallet...');
  const walletCtx = await createWallet({ network, networkConfig, seed: SEED });
  const state = await walletCtx.wallet.waitForSyncedState();
  await persistWalletState(network, walletCtx);
  console.log('  ✓ Synced.\n');

  const zkConfigProvider = new NodeZkConfigProvider(zkConfigPath);
  const walletProvider = {
    getCoinPublicKey: () => state.shielded.coinPublicKey.toHexString(),
    getEncryptionPublicKey: () => state.shielded.encryptionPublicKey.toHexString(),
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
      privateStoragePasswordProvider: () => 'Local-Devnet-Development-Placeholder-1',
    }),
    publicDataProvider: indexerPublicDataProvider(networkConfig.indexer, networkConfig.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(networkConfig.proofServer, zkConfigProvider),
    walletProvider,
    midnightProvider: walletProvider,
  };

  console.log('  Connecting to Exchange contract...');
  const found: any = await findDeployedContract(providers, {
    compiledContract: compiledContract as any,
    contractAddress: deployment.address,
  });
  console.log('  ✓ Connected.\n');

  const nightKey = encodeRawTokenType(unshieldedToken().raw);

  console.log('  Submitting depositTreasury(NIGHT)...');
  const nightTx = await found.callTx.depositTreasury(nightKey, nightWhole);
  console.log(`  ✅ NIGHT deposited. tx: ${nightTx?.public?.txId ?? '(submitted)'}\n`);

  console.log('  Submitting depositTreasury(tZKR)...');
  const tzkrTx = await found.callTx.depositTreasury(tzkrColor, tzkrAmount);
  console.log(`  ✅ tZKR deposited. tx: ${tzkrTx?.public?.txId ?? '(submitted)'}\n`);

  const contractState = await providers.publicDataProvider.queryContractState(deployment.address);
  if (contractState) {
    const led = Exchange.ledger(contractState.data);
    const nightBal = led.treasuryBalances.member(nightKey) ? led.treasuryBalances.lookup(nightKey) : 0n;
    const tzkrBal = led.treasuryBalances.member(tzkrColor) ? led.treasuryBalances.lookup(tzkrColor) : 0n;
    console.log(`  On-chain Treasury NIGHT balance: ${nightBal.toLocaleString()}`);
    console.log(`  On-chain Treasury tZKR balance:  ${tzkrBal.toLocaleString()}\n`);
  }

  await persistWalletState(network, walletCtx);
  await walletCtx.wallet.stop();
  console.log('─── Treasury seeding complete ──────────────────────────────────\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
