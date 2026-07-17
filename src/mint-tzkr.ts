/**
 * Mint the demo tZKR supply to the deployer/admin wallet (the token owner).
 *
 * Non-interactive and CLI-driven, reusing the exact wallet/network/provider
 * plumbing of src/deploy.ts and src/cli.ts. Connects to the already-deployed
 * tZKR contract (address from .midnight-tzkr.json) and calls the owner-gated
 * `mint` circuit from the owner identity.
 *
 * Usage:
 *   npm run mint:tzkr -- --network preprod [--amount <whole-tokens>]
 *
 * --amount is in WHOLE tokens (default 1,000,000); it is scaled by the token's
 * 6 decimals into base units on-chain. Recipient defaults to the owner's own
 * account id; pass --to <64-hex-account-id> to mint elsewhere.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';

import { resolveNetwork, getOrCreateSeed, getOrCreateAdminSecret } from './network';
import { createWallet, persistWalletState, type WalletContext } from './wallet';
import { getTzkrDeployment, TZKR_TOKEN_DECIMALS } from './tzkr-state';

import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import type { Contract as TzkrContract } from '../contracts/managed/tzkr-token/contract/index.js';

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
const zkConfigPath = path.resolve(__dirname, '..', 'contracts', 'managed', 'tzkr-token');
const contractPath = path.join(zkConfigPath, 'contract', 'index.js');
if (!fs.existsSync(contractPath)) {
  console.error('\n❌ tZKR contract not compiled! Run: npm run compile:tzkr\n');
  process.exit(1);
}
const Tzkr = await import(pathToFileURL(contractPath).href);

const ownerSecretHex = getOrCreateAdminSecret(network);
const ownerSecret = Buffer.from(ownerSecretHex, 'hex');
const ownerAccountId: Uint8Array = Tzkr.pureCircuits.deriveAccountId(ownerSecret);

// Both witnesses return the owner secret so `mint`'s Ownable_assertOnlyOwner
// derives the caller as the token owner.
const tzkrWitnesses = {
  wit_OwnableSK: (ctx: any): [any, Uint8Array] => [ctx.privateState, ownerSecret],
  wit_FungibleTokenSK: (ctx: any): [any, Uint8Array] => [ctx.privateState, ownerSecret],
};

const compiledContractBase = CompiledContract.make<TzkrContract<undefined>>('tzkr-token', Tzkr.Contract);
const compiledContractWithWitnesses = CompiledContract.withWitnesses(compiledContractBase, tzkrWitnesses);
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
      privateStateStoreName: 'tzkr-token-state',
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
  const deployment = getTzkrDeployment(network);
  if (!deployment) {
    console.error(`\n❌ No tZKR deployment recorded for ${network}. Run: npm run deploy:tzkr -- --network ${network}\n`);
    process.exit(1);
  }

  const wholeTokens = BigInt(parseArg('amount') ?? '1000000');
  const scale = 10n ** BigInt(TZKR_TOKEN_DECIMALS);
  const amount = wholeTokens * scale;

  const toHex = parseArg('to');
  const recipientId = toHex ? Buffer.from(toHex.replace(/^0x/, ''), 'hex') : ownerAccountId;
  const recipient = { is_left: true, left: recipientId, right: { bytes: new Uint8Array(32) } };

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log(`║  Mint tZKR demo supply on ${network}`);
  console.log('╚══════════════════════════════════════════════════════════════╝\n');
  console.log(`  Contract:  ${deployment.address}`);
  console.log(`  Recipient: ${Buffer.from(recipientId).toString('hex')}`);
  console.log(`  Amount:    ${wholeTokens.toLocaleString()} tZKR (${amount.toLocaleString()} base units @ ${TZKR_TOKEN_DECIMALS} decimals)\n`);

  console.log('  Creating + syncing wallet...');
  const walletCtx = await createWallet({ network, networkConfig, seed: SEED });
  await walletCtx.wallet.waitForSyncedState();
  await persistWalletState(network, walletCtx);
  console.log('  ✓ Synced.\n');

  const providers = await createProviders(walletCtx);
  console.log('  Connecting to tZKR contract...');
  const found: any = await findDeployedContract(providers, {
    compiledContract: compiledContract as any,
    contractAddress: deployment.address,
  });
  console.log('  ✓ Connected.\n');

  console.log('  Submitting mint transaction (build → prove → submit)...');
  const tx = await found.callTx.mint(recipient, amount);
  const txId = tx?.public?.txId ?? tx?.txId ?? '(submitted)';
  console.log(`  ✅ Minted! tx: ${txId}\n`);

  // Read back on-chain balance + total supply to confirm the mint landed and is spendable.
  try {
    const contractState = await providers.publicDataProvider.queryContractState(deployment.address);
    if (contractState) {
      const led = Tzkr.ledger(contractState.data);
      const bal = led._balances.member(recipient) ? led._balances.lookup(recipient) : 0n;
      console.log(`  On-chain balance of recipient: ${bal.toLocaleString()} base units`);
      console.log(`  On-chain total supply:         ${led._totalSupply.toLocaleString()} base units\n`);
    }
  } catch (e) {
    console.log(`  (balance read-back skipped: ${e instanceof Error ? e.message : e})\n`);
  }

  await persistWalletState(network, walletCtx);
  await walletCtx.wallet.stop();
  console.log('─── Mint complete ──────────────────────────────────────────────\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
