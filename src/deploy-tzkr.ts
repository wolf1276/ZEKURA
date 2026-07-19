/**
 * Deploy the Zekura Test Token (tZKR) — a native unshielded token contract —
 * to a Midnight network (undeployed by default; use --network preview|preprod
 * for public networks). Mirrors src/deploy.ts's flow exactly — same
 * wallet/network plumbing, same faucet-fund poll, same DUST setup, same
 * deploy-retry loop — so it slots into the existing `npm run setup`
 * conventions.
 *
 * The token contract (see contracts/tzkr-token.compact) mints a genuine
 * chain-wide unshielded token color via mintUnshieldedToken — not an
 * OpenZeppelin FungibleToken-style contract-internal ledger (that approach
 * was abandoned; see docs/ARCHITECTURE_TZKR_UNSHIELDED_MIGRATION.md for why
 * it could never be custodied by the Exchange's Treasury). The deployer
 * wallet becomes the token owner (the only identity allowed to mint); the
 * demo supply is minted afterwards by src/mint-tzkr.ts, which also records
 * the real minted color back into .midnight-tzkr.json.
 *
 * The resulting address is written to .midnight-tzkr.json (gitignored, a
 * separate file from .midnight-state.json so it never clobbers the exchange
 * deployment record) and printed as `tZKR Contract Address: <address>`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import * as Rx from 'rxjs';

import { resolveNetwork, getOrCreateSeed, getOrCreateAdminSecret } from './network';
import { createWallet, persistWalletState, startCheckpointing, unshieldedToken, type WalletContext } from './wallet';
import { recordTzkrDeployment } from './tzkr-state';

import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
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

async function waitForProofServer(maxAttempts = 60, delayMs = 2000): Promise<boolean> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await fetch(networkConfig.proofServer, { method: 'GET', signal: AbortSignal.timeout(3000) });
      return true;
    } catch (err: any) {
      const code = err?.cause?.code || err?.code || '';
      if (code !== 'ECONNREFUSED' && code !== 'UND_ERR_CONNECT_TIMEOUT' && code !== 'UND_ERR_SOCKET') return true;
    }
    if (attempt < maxAttempts) {
      process.stdout.write(`\r  Waiting for proof server... (${attempt}/${maxAttempts})   `);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return false;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const zkConfigPath = path.resolve(__dirname, '..', 'contracts', 'managed', 'tzkr-token');
const contractPath = path.join(zkConfigPath, 'contract', 'index.js');

if (!fs.existsSync(contractPath)) {
  console.error('\n❌ tZKR contract not compiled! Run: npm run compile:tzkr\n');
  process.exit(1);
}

const Tzkr = await import(pathToFileURL(contractPath).href);

// The token owner (mint authority). Reuses the same per-network admin secret
// the exchange Treasury uses, so a single operator identity owns both. The
// on-chain owner is the derived key = deriveOwnerKey(secret) (the constructor
// stores only this hash — the raw secret never appears on-chain). This
// contract declares no witnesses at all (mint takes the secret as an ordinary,
// non-disclosed circuit argument instead), so no witness object is needed.
const ownerSecretHex = getOrCreateAdminSecret(network);
const ownerSecret = Buffer.from(ownerSecretHex, 'hex');
const ownerId: Uint8Array = Tzkr.pureCircuits.deriveOwnerKey(ownerSecret);

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
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log(`║  Deploy Zekura Test Token (tZKR) to ${network}`);
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  console.log('─── Wallet setup ───────────────────────────────────────────────\n');
  console.log('  Creating wallet...');
  const walletCtx = await createWallet({ network, networkConfig, seed: SEED });

  console.log('  Syncing with network...');
  const syncStart = Date.now();
  const syncInterval = setInterval(() => {
    const elapsed = Math.round((Date.now() - syncStart) / 1000);
    process.stdout.write(`\r  ⏳ Still syncing... (${elapsed}s elapsed)   `);
  }, 5000);
  const checkpoint = startCheckpointing(network, walletCtx);
  const state = await walletCtx.wallet.waitForSyncedState();
  checkpoint.stop();
  clearInterval(syncInterval);
  process.stdout.write('\r  ✓ Synced with network.                                      \n');
  await persistWalletState(network, walletCtx);

  const address = walletCtx.unshieldedKeystore.getBech32Address();
  const balance = state.unshielded.balances[unshieldedToken().raw] ?? 0n;
  console.log(`\n  Wallet Address: ${address}`);
  console.log(`  Balance: ${balance.toLocaleString()} tNight\n`);

  // Faucet poll for public networks.
  if (network !== 'undeployed' && networkConfig.faucet) {
    const initial = await Rx.firstValueFrom(walletCtx.wallet.state().pipe(Rx.filter((s) => s.isSynced)));
    const initialTNight = initial.unshielded.balances[unshieldedToken().raw] ?? 0n;
    if (initialTNight === 0n) {
      console.log('─── Fund Wallet ────────────────────────────────────────────────\n');
      console.log(`  Wallet address: ${address}`);
      console.log(`  Faucet:         ${networkConfig.faucet}\n`);
      console.log('  Waiting for tNIGHT to arrive (poll every 10s)...');
      const rawTimeout = Number(process.env.MIDNIGHT_FAUCET_TIMEOUT_MS);
      const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 600_000;
      const start = Date.now();
      while (true) {
        await new Promise((r) => setTimeout(r, 10_000));
        const s = await Rx.firstValueFrom(walletCtx.wallet.state().pipe(Rx.filter((x) => x.isSynced)));
        const tn = s.unshielded.balances[unshieldedToken().raw] ?? 0n;
        if (tn > 0n) { console.log(`\n  Funded! tNIGHT balance: ${tn.toLocaleString()}\n`); break; }
        if (Date.now() - start > timeoutMs) {
          console.log(`\n  ❌ Funding not received within ${Math.round(timeoutMs / 60_000)} min.`);
          await walletCtx.wallet.stop();
          process.exit(1);
        }
        process.stdout.write(`\r  ...still waiting (${Math.round((Date.now() - start) / 1000)}s elapsed)`);
      }
    }
  }

  // Register NIGHT for DUST generation (fees).
  console.log('─── DUST Token Setup ───────────────────────────────────────────\n');
  const dustState = await Rx.firstValueFrom(walletCtx.wallet.state().pipe(Rx.filter((s) => s.isSynced)));
  // Only NIGHT UTXOs are eligible for DUST generation — this wallet also
  // holds tZKR (it mints/owns the token itself), and including a non-Night
  // coin here makes the chain reject the registration tx outright with
  // "Token of a non-Night type received".
  const unregisteredUtxos = dustState.unshielded.availableCoins.filter(
    (c: any) => !c.meta?.registeredForDustGeneration && c.utxo?.type === unshieldedToken().raw,
  );
  if (unregisteredUtxos.length > 0) {
    console.log(`  Registering ${unregisteredUtxos.length} NIGHT UTXOs for DUST generation...`);
    const REGISTER_MAX_RETRIES = 5;
    const REGISTER_RETRY_DELAY_MS = 3000;
    for (let attempt = 1; attempt <= REGISTER_MAX_RETRIES; attempt++) {
      await new Promise((r) => setTimeout(r, REGISTER_RETRY_DELAY_MS));
      try {
        const recipe = await walletCtx.wallet.registerNightUtxosForDustGeneration(
          unregisteredUtxos,
          walletCtx.unshieldedKeystore.getPublicKey(),
          (payload) => walletCtx.unshieldedKeystore.signData(payload),
        );
        const finalized = await walletCtx.wallet.finalizeRecipe(recipe);
        await walletCtx.wallet.submitTransaction(finalized);
        break;
      } catch (err: any) {
        if (attempt === REGISTER_MAX_RETRIES) throw err;
        console.log(`  Attempt ${attempt} failed (${err?.message || err}); retrying...`);
      }
    }
  }
  if (dustState.dust.balance(new Date()) === 0n) {
    console.log('  Waiting for DUST tokens...');
    await Rx.firstValueFrom(
      walletCtx.wallet.state().pipe(
        Rx.throttleTime(5000),
        Rx.filter((s) => s.isSynced),
        Rx.filter((s) => s.dust.balance(new Date()) > 0n),
      ),
    );
  }
  console.log('  DUST tokens ready!\n');

  console.log('─── Deploy tZKR Contract ───────────────────────────────────────\n');
  console.log('  Checking proof server...');
  if (!(await waitForProofServer())) {
    console.log('\n  ❌ Proof server not responding. Run: docker compose up -d proof-server\n');
    await walletCtx.wallet.stop();
    process.exit(1);
  }
  process.stdout.write('\r  Proof server ready!                                 \n');

  const providers = await createProviders(walletCtx);

  process.stdout.write('  Generating DUST...');
  await new Promise((r) => setTimeout(r, 6000));
  process.stdout.write(' done.\n');
  console.log('  Deploying contract...\n');

  const MAX_RETRIES = 20;
  const RETRY_DELAY_MS = 5000;
  let deployed: Awaited<ReturnType<typeof deployContract>> | undefined;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      deployed = await deployContract(providers, {
        compiledContract: compiledContract as any,
        args: [ownerSecret],
      });
      break;
    } catch (err: any) {
      const fullError = `${err?.message || ''} ${err?.cause?.message || ''}`;
      const isDustShortage =
        fullError.includes('Not enough Dust') ||
        fullError.includes('Insufficient Funds') ||
        fullError.includes('could not balance dust');
      if (!(isDustShortage && attempt === 1)) console.error(`\n  Attempt ${attempt} error: ${err?.message}`);
      if (isDustShortage && attempt < MAX_RETRIES) {
        console.log(`  Still generating DUST, retrying in ${RETRY_DELAY_MS / 1000}s...`);
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      } else if (isDustShortage) {
        console.log('  ❌ Not enough DUST after all retries.');
        await walletCtx.wallet.stop();
        process.exit(1);
      } else {
        throw err;
      }
    }
  }
  if (!deployed) throw new Error('tZKR deployment failed after all retries');

  const contractAddress = deployed.deployTxData.public.contractAddress;
  console.log('  ✅ tZKR deployed successfully!\n');
  console.log(`  tZKR Contract Address: ${contractAddress}\n`);
  console.log(`  Token owner id: ${Buffer.from(ownerId).toString('hex')}`);
  console.log('  (mint authority — src/mint-tzkr.ts supplies the matching secret directly to mint())\n');
  console.log('  Token has zero supply and no color yet — the first npm run mint:tzkr call mints both.\n');

  recordTzkrDeployment(network, {
    address: contractAddress,
    deployer: address.toString(),
    ownerAccountId: Buffer.from(ownerId).toString('hex'),
  });
  console.log('  Saved to .midnight-tzkr.json\n');

  await persistWalletState(network, walletCtx);
  await walletCtx.wallet.stop();
  console.log('─── tZKR deployment complete ───────────────────────────────────\n');
  console.log('  Next: npm run mint:tzkr -- --network ' + network + '\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
