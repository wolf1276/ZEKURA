/**
 * Mint the demo tZKR supply — a real, chain-wide unshielded token color — to
 * a wallet address.
 *
 * Non-interactive and CLI-driven, reusing the exact wallet/network/provider
 * plumbing of src/deploy.ts and src/cli.ts. Connects to the already-deployed
 * tZKR contract (address from .midnight-tzkr.json) and calls the owner-gated
 * `mint` circuit, which mints directly to `recipient` (no separate transfer
 * step — see contracts/tzkr-token.compact). After a successful mint, records
 * the real minted color back into .midnight-tzkr.json (src/tzkr-state.ts's
 * recordTzkrColor) — every other consumer (Exchange OrderDetails.asset,
 * Treasury assetKey, wallet unshielded balance lookups) needs this color,
 * not the contract's address.
 *
 * Usage:
 *   npm run mint:tzkr -- --network preprod [--amount <whole-tokens>] [--to <64-hex-user-address>]
 *
 * --amount is in WHOLE tokens (default 1,000,000); it is scaled by
 * TZKR_TOKEN_DECIMALS into base units on-chain (capped at Uint<64> per mint —
 * mintUnshieldedToken's own protocol limit; call this again to top up
 * further). Recipient defaults to this script's own wallet address; pass
 * --to <64-hex-address> to mint directly to a different real wallet instead
 * (e.g. a test buyer/seller).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';

import { resolveNetwork, getOrCreateSeed, getOrCreateAdminSecret } from './network';
import { createWallet, persistWalletState, type WalletContext } from './wallet';
import { getTzkrDeployment, recordTzkrColor, TZKR_TOKEN_DECIMALS } from './tzkr-state';

import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { encodeUserAddress } from '@midnight-ntwrk/ledger-v8';
import { MidnightBech32m, UnshieldedAddress } from '@midnight-ntwrk/wallet-sdk-address-format';
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

// This contract declares no witnesses — mint takes the owner secret as an
// ordinary (non-disclosed) circuit argument instead, so no witness object is
// needed at all.
const compiledContractBase = CompiledContract.make<TzkrContract<undefined>>('tzkr-token', Tzkr.Contract);
const compiledContractWithWitnesses = CompiledContract.withVacantWitnesses(compiledContractBase);
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

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log(`║  Mint tZKR demo supply on ${network}`);
  console.log('╚══════════════════════════════════════════════════════════════╝\n');
  console.log(`  Contract: ${deployment.address}`);
  console.log(`  Amount:   ${wholeTokens.toLocaleString()} tZKR (${amount.toLocaleString()} base units @ ${TZKR_TOKEN_DECIMALS} decimals)\n`);

  console.log('  Creating + syncing wallet...');
  const walletCtx = await createWallet({ network, networkConfig, seed: SEED });
  await walletCtx.wallet.waitForSyncedState();
  await persistWalletState(network, walletCtx);
  console.log('  ✓ Synced.\n');

  // Recipient must be a real, spendable UserAddress — mintUnshieldedToken
  // creates an actual on-chain UTXO for it, unlike the old FungibleToken
  // contract's arbitrary internal account-id keys. Defaults to this script's
  // own wallet; --to <64-hex-address> mints directly to a different real
  // wallet instead (see scripts/e2e-check.ts's withdrawTreasury for the same
  // bech32m -> hex UserAddress conversion).
  const toHex = parseArg('to');
  let recipientAddressBytes: Uint8Array;
  if (toHex) {
    recipientAddressBytes = encodeUserAddress(toHex.replace(/^0x/, ''));
  } else {
    const ownBech32Address = walletCtx.unshieldedKeystore.getBech32Address().toString();
    const ownAddressHex = MidnightBech32m.parse(ownBech32Address).decode(UnshieldedAddress, getNetworkId()).hexString;
    recipientAddressBytes = encodeUserAddress(ownAddressHex);
  }
  const recipient = { is_left: false, left: { bytes: new Uint8Array(32) }, right: { bytes: recipientAddressBytes } };
  console.log(`  Recipient: ${Buffer.from(recipientAddressBytes).toString('hex')}\n`);

  const providers = await createProviders(walletCtx);
  console.log('  Connecting to tZKR contract...');
  const found: any = await findDeployedContract(providers, {
    compiledContract: compiledContract as any,
    contractAddress: deployment.address,
  });
  console.log('  ✓ Connected.\n');

  console.log('  Submitting mint transaction (build → prove → submit)...');
  const tx = await found.callTx.mint(ownerSecret, recipient, amount);
  const txId = tx?.public?.txId ?? tx?.txId ?? '(submitted)';
  console.log(`  ✅ Minted! tx: ${txId}\n`);

  // Read back the real minted color and record it — every other consumer
  // (Exchange OrderDetails.asset, Treasury assetKey, wallet unshielded
  // balance lookups) needs this color, not the contract's address.
  try {
    const contractState = await providers.publicDataProvider.queryContractState(deployment.address);
    if (contractState) {
      const led = Tzkr.ledger(contractState.data);
      const colorHex = Buffer.from(led.token_color as Uint8Array).toString('hex');
      console.log(`  Real tZKR color: ${colorHex}`);
      recordTzkrColor(network, colorHex);
      console.log('  Saved to .midnight-tzkr.json\n');
    }
  } catch (e) {
    console.log(`  (color read-back/record skipped: ${e instanceof Error ? e.message : e})\n`);
  }

  await persistWalletState(network, walletCtx);
  await walletCtx.wallet.stop();
  console.log('─── Mint complete ──────────────────────────────────────────────\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
