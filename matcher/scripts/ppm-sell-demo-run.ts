/**
 * Drives one complete SELL flow against the running Matcher (DEMO_PPM_SELL=true)
 * for manual verification: submits a real createOrder on-chain, then POSTs the
 * same order to the Matcher's /orders endpoint and prints the response.
 *
 * One-off verification script, not part of the test suite. Usage:
 *   npx tsx matcher/scripts/ppm-sell-demo-run.ts
 */
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';

import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { CompiledContract } from '@midnight-ntwrk/compact-js';

import { resolveNetwork, getOrCreateSeed, getDeployment } from '../../src/network.js';
import { createWallet, persistWalletState } from '../../src/wallet.js';
import { computeCommitmentHex, toOrderDetailsValue } from '../src/utils/orderDetailsCodec.js';

// @ts-expect-error required for wallet sync
globalThis.WebSocket = WebSocket;

const { network, config: networkConfig } = resolveNetwork();
const SEED = getOrCreateSeed(network);
const MATCHER_URL = process.env.MATCHER_URL ?? 'http://localhost:4000';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const zkConfigPath = path.resolve(__dirname, '..', '..', 'contracts', 'managed', 'exchange');
const contractPath = path.join(zkConfigPath, 'contract', 'index.js');
const Exchange = await import(pathToFileURL(contractPath).href);

// createOrder needs no witnesses — see contracts/exchange.compact.
const exchangeWitnesses = {
  orderDetails: () => {
    throw new Error('not implemented — this script only calls createOrder');
  },
  orderBlinding: () => {
    throw new Error('not implemented — this script only calls createOrder');
  },
  ownerSecretKey: () => {
    throw new Error('not implemented — this script only calls createOrder');
  },
  adminSecretKey: () => {
    throw new Error('not implemented — this script only calls createOrder');
  },
};

const compiledContractBase = CompiledContract.make('exchange', Exchange.Contract);
const compiledContractWithWitnesses = CompiledContract.withWitnesses(compiledContractBase, exchangeWitnesses);
const compiledContract = CompiledContract.withCompiledFileAssets(compiledContractWithWitnesses, zkConfigPath);

async function main() {
  const deployment = getDeployment(network);
  if (!deployment) throw new Error(`No exchange deployment recorded for ${network}`);

  console.log(`\n─── PPM SELL demo run (${network}) ───\n`);
  console.log('Creating + syncing wallet...');
  const walletCtx = await createWallet({ network, networkConfig, seed: SEED });
  const state = await walletCtx.wallet.waitForSyncedState();
  await persistWalletState(network, walletCtx);
  console.log('✓ Synced.\n');

  const privateStatePassword = process.env.PRIVATE_STATE_PASSWORD?.trim() || 'Local-Devnet-Development-Placeholder-1';
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
  const providers = {
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

  console.log('Connecting to exchange contract...');
  const found: any = await findDeployedContract(providers, {
    compiledContract: compiledContract as any,
    contractAddress: deployment.address,
  });
  console.log('✓ Connected.\n');

  // PPM_ASSET_ADAPTER from web/src/lib/mock/market.ts: assetIsLeft false,
  // both legs the all-zero NIGHT token type.
  const asset = { isLeft: false, left: '00'.repeat(32), right: '00'.repeat(32) };
  const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 3600);

  async function submitOnChainAndToMatcher(opts: { side: 'BUY' | 'SELL'; price: bigint; amount: bigint }) {
    const orderId = randomBytes(32).toString('hex');
    const signature = randomBytes(32).toString('hex'); // blinding factor
    const ownerId = randomBytes(32).toString('hex');
    const details = toOrderDetailsValue({ asset, side: opts.side, price: opts.price, amount: opts.amount, ownerId, expiresAt });
    const commitment = computeCommitmentHex(details, signature);

    const orderIdBytes = Buffer.from(orderId, 'hex');
    const commitmentBytes = Buffer.from(commitment, 'hex');
    const tx = await found.callTx.createOrder(orderIdBytes, commitmentBytes);
    const txId = tx?.public?.txId ?? tx?.txId ?? '(submitted)';
    console.log(`  createOrder confirmed on-chain (${opts.side} ${opts.amount}@${opts.price}), tx: ${txId}`);

    const res = await fetch(`${MATCHER_URL}/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: orderId,
        asset,
        side: opts.side,
        price: opts.price.toString(),
        amount: opts.amount.toString(),
        commitment,
        ownerId,
        signature,
        expiresAt: expiresAt.toString(),
        payoutAddress: null,
      }),
    });
    const body = await res.json();
    return { status: res.status, body };
  }

  // Step 1: seed a real user/user trade so MarketDataService has a
  // lastPrice — PricingEngine.quote() deliberately refuses to quote with no
  // independent reference price (see its doc comment), so the PPM step
  // below would otherwise never produce a quote.
  console.log('Seeding a resting BUY @1000 to establish a market reference price...');
  await submitOnChainAndToMatcher({ side: 'BUY', price: 1000n, amount: 10n });
  console.log('Submitting a crossing SELL @1000 to fill it (real settle() on-chain)...');
  const seedFill = await submitOnChainAndToMatcher({ side: 'SELL', price: 1000n, amount: 10n });
  console.log(`  matched: ${JSON.stringify(seedFill.body.match !== undefined ? !!seedFill.body.match : seedFill.body)}\n`);

  // Step 2: the actual demo SELL — priced at 900, safely under the PPM's
  // ~995 sell-side quote (1000 reference minus its spread) so it crosses.
  console.log('Submitting the demo PPM SELL order (price 900, below the ~995 PPM quote)...');
  const result = await submitOnChainAndToMatcher({ side: 'SELL', price: 900n, amount: 50n });
  console.log(`\nMatcher response (${result.status}):`);
  console.log(JSON.stringify(result.body, null, 2));

  await persistWalletState(network, walletCtx);
  await walletCtx.wallet.stop();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
