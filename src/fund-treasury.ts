/**
 * Fund the exchange contract's Treasury via depositTreasury — the only real
 * admin op the PPM demo needs before a fill can be reserved (see
 * contracts/exchange.compact's Treasury section and README's "Treasury").
 *
 * Non-interactive and CLI-driven, reusing the exact wallet/network/provider
 * plumbing of src/deploy.ts/src/mint-tzkr.ts. Connects to the already-deployed
 * exchange contract and calls depositTreasury from the bootstrap admin
 * identity persisted by deploy.ts (.midnight-state.json's adminSecrets).
 *
 * Usage:
 *   npm run fund:treasury -- --network preprod --assetKey <64-hex> --amount <base-units>
 *
 * --assetKey defaults to the NIGHT payment-leg key (32 zero bytes) — the
 * PPM_ASSET_ADAPTER pair in web/src/lib/mock/market.ts uses this same key
 * for its traded-asset leg (assetIsLeft: false, quoteAssetId all-zero), so
 * one deposit funds both the NIGHT-payment bucket and that pair's
 * asset-side bucket in the same Treasury map entry.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';

import { resolveNetwork, getOrCreateSeed, getOrCreateAdminSecret, getDeployment } from './network';
import { createWallet, persistWalletState, type WalletContext } from './wallet';

import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import type { Contract as ExchangeContract, Witnesses } from '../contracts/managed/exchange/contract/index.js';

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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const zkConfigPath = path.resolve(__dirname, '..', 'contracts', 'managed', 'exchange');
const contractPath = path.join(zkConfigPath, 'contract', 'index.js');
if (!fs.existsSync(contractPath)) {
  console.error('\n❌ Contract not compiled! Run: npm run compile\n');
  process.exit(1);
}
const Exchange = await import(pathToFileURL(contractPath).href);

const adminSecretHex = getOrCreateAdminSecret(network);
const adminSecretBytes = Buffer.from(adminSecretHex, 'hex');

const exchangeWitnesses: Witnesses<undefined> = {
  orderDetails: () => {
    throw new Error('orderDetails witness not implemented in fund-treasury.ts (only depositTreasury is called).');
  },
  orderBlinding: () => {
    throw new Error('orderBlinding witness not implemented in fund-treasury.ts (only depositTreasury is called).');
  },
  ownerSecretKey: () => {
    throw new Error('ownerSecretKey witness not implemented in fund-treasury.ts (only depositTreasury is called).');
  },
  adminSecretKey: (context) => [context.privateState, adminSecretBytes],
};

const compiledContractBase = CompiledContract.make<ExchangeContract<undefined>>('exchange', Exchange.Contract);
const compiledContractWithWitnesses = CompiledContract.withWitnesses(compiledContractBase, exchangeWitnesses);
const compiledContract = CompiledContract.withCompiledFileAssets(compiledContractWithWitnesses, zkConfigPath);

async function createProviders(walletCtx: WalletContext) {
  const privateStatePassword = process.env.PRIVATE_STATE_PASSWORD?.trim() || 'Local-Devnet-Development-Placeholder-1';
  const state = await walletCtx.wallet.waitForSyncedState();
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
  };
  const zkConfigProvider = new NodeZkConfigProvider(zkConfigPath);
  const accountId = walletCtx.unshieldedKeystore.getBech32Address().toString();
  return {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: 'exchange-state',
      accountId,
      privateStoragePasswordProvider: () => privateStatePassword,
    }),
    publicDataProvider: indexerPublicDataProvider(networkConfig.indexer, networkConfig.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(networkConfig.proofServer, zkConfigProvider),
    walletProvider,
    midnightProvider: walletProvider,
  };
}

async function main() {
  const deployment = getDeployment(network);
  if (!deployment) {
    console.error(`\n❌ No exchange deployment recorded for ${network}. Run: npm run deploy -- --network ${network}\n`);
    process.exit(1);
  }

  const assetKeyHex = parseArg('assetKey') ?? '00'.repeat(32);
  const assetKey = Buffer.from(assetKeyHex, 'hex');
  const amount = BigInt(parseArg('amount') ?? '1000000');

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log(`║  Fund exchange Treasury on ${network}`);
  console.log('╚══════════════════════════════════════════════════════════════╝\n');
  console.log(`  Contract:  ${deployment.address}`);
  console.log(`  AssetKey:  ${assetKeyHex}`);
  console.log(`  Amount:    ${amount.toLocaleString()} base units\n`);

  console.log('  Creating + syncing wallet...');
  const walletCtx = await createWallet({ network, networkConfig, seed: SEED });
  await walletCtx.wallet.waitForSyncedState();
  await persistWalletState(network, walletCtx);
  console.log('  ✓ Synced.\n');

  const providers = await createProviders(walletCtx);
  console.log('  Connecting to exchange contract...');
  const found: any = await findDeployedContract(providers, {
    compiledContract: compiledContract as any,
    contractAddress: deployment.address,
  });
  console.log('  ✓ Connected.\n');

  console.log('  Submitting depositTreasury transaction (build → prove → submit)...');
  const tx = await found.callTx.depositTreasury(assetKey, amount);
  const txId = tx?.public?.txId ?? tx?.txId ?? '(submitted)';
  console.log(`  ✅ Deposited! tx: ${txId}\n`);

  try {
    const contractState = await providers.publicDataProvider.queryContractState(deployment.address);
    if (contractState) {
      const led = Exchange.ledger(contractState.data);
      const bal = led.treasuryBalances.member(assetKey) ? led.treasuryBalances.lookup(assetKey) : 0n;
      console.log(`  On-chain treasury balance for this asset: ${bal.toLocaleString()} base units\n`);
    }
  } catch (e) {
    console.log(`  (balance read-back skipped: ${e instanceof Error ? e.message : e})\n`);
  }

  await persistWalletState(network, walletCtx);
  await walletCtx.wallet.stop();
  console.log('─── Deposit complete ───────────────────────────────────────────\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
