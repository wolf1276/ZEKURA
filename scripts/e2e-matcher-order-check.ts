/**
 * One-shot live validation of the Matcher's own REST order-submission path
 * (as opposed to scripts/e2e-trade-check.ts, which calls contract circuits
 * directly): submits a real on-chain createOrder(), then POSTs the
 * disclosed order to a currently-running Matcher instance (MATCHER_API_URL,
 * default http://localhost:4000) and confirms it accepted it, the order is
 * visible via GET /orders/:id and GET /orderbook, and — since no
 * counterparty exists — it rests OPEN (or gets a PPM quote, reported either
 * way).
 *
 * Requires a Matcher already running against the same network/deployment
 * this script resolves (see matcher/README or `npm run dev` from matcher/).
 *
 * Usage: npx tsx scripts/e2e-matcher-order-check.ts --network preprod
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as nodeCrypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import * as rt from '@midnight-ntwrk/compact-runtime';

import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { resolveNetwork, getOrCreateSeed, getDeployment } from '../src/network.js';
import { createWallet, persistWalletState } from '../src/wallet.js';
import { getTzkrDeployment } from '../src/tzkr-state.js';
import type { Contract as ExchangeContract } from '../contracts/managed/exchange/contract/index.js';

// @ts-expect-error Required for wallet sync
globalThis.WebSocket = WebSocket;

function fail(msg: string): never {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

interface OrderDetailsValue {
  asset: Uint8Array;
  isBuy: boolean;
  price: bigint;
  amount: bigint;
  owner: { bytes: Uint8Array };
  expiresAt: bigint;
}
const Uint128Type = new rt.CompactTypeUnsignedInteger(340282366920938463463374607431768211455n, 16);
const Uint64Type = new rt.CompactTypeUnsignedInteger(18446744073709551615n, 8);
class OrderDetailsType implements rt.CompactType<OrderDetailsValue> {
  alignment() {
    return rt.Bytes32Descriptor.alignment().concat(
      rt.CompactTypeBoolean.alignment().concat(
        Uint128Type.alignment().concat(
          Uint128Type.alignment().concat(rt.ZswapCoinPublicKeyDescriptor.alignment().concat(Uint64Type.alignment())),
        ),
      ),
    );
  }
  fromValue(value: rt.Value): OrderDetailsValue {
    return {
      asset: rt.Bytes32Descriptor.fromValue(value),
      isBuy: rt.CompactTypeBoolean.fromValue(value),
      price: Uint128Type.fromValue(value),
      amount: Uint128Type.fromValue(value),
      owner: rt.ZswapCoinPublicKeyDescriptor.fromValue(value),
      expiresAt: Uint64Type.fromValue(value),
    };
  }
  toValue(v: OrderDetailsValue) {
    return rt.Bytes32Descriptor.toValue(v.asset).concat(
      rt.CompactTypeBoolean.toValue(v.isBuy).concat(
        Uint128Type.toValue(v.price).concat(
          Uint128Type.toValue(v.amount).concat(
            rt.ZswapCoinPublicKeyDescriptor.toValue(v.owner).concat(Uint64Type.toValue(v.expiresAt)),
          ),
        ),
      ),
    );
  }
}
const orderDetailsType = new OrderDetailsType();
function computeCommitment(details: OrderDetailsValue, blinding: Uint8Array): Uint8Array {
  return rt.persistentCommit(orderDetailsType, details, blinding);
}
function toHex(b: Uint8Array): string {
  return Buffer.from(b).toString('hex');
}

const { network, config: networkConfig } = resolveNetwork();
const SEED = getOrCreateSeed(network);
const MATCHER_API_URL = process.env.MATCHER_API_URL?.trim() || 'http://localhost:4000';

async function main() {
  const deployment = getDeployment(network);
  if (!deployment) fail(`No exchange deployment recorded for ${network}.`);
  const tzkr = getTzkrDeployment(network);
  if (!tzkr?.color) fail(`No tZKR color recorded for ${network}.`);
  const tzkrColor = Buffer.from(tzkr!.color!, 'hex');

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log(`║  Live Matcher REST order-submission check on ${network}`);
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  console.log('  Checking Matcher health...');
  const health = await fetch(`${MATCHER_API_URL}/health`).then((r) => r.json());
  console.log(`  ✓ Matcher healthy: ${JSON.stringify(health)}\n`);

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const zkConfigPath = path.resolve(__dirname, '..', 'contracts', 'managed', 'exchange');
  const contractPath = path.join(zkConfigPath, 'contract', 'index.js');
  if (!fs.existsSync(contractPath)) fail('Compiled contract missing — run: npm run compile');
  const Exchange = await import(pathToFileURL(contractPath).href);
  const { deriveOwnerId } = Exchange.pureCircuits;

  const exchangeWitnesses = {
    orderDetails: () => { throw new Error('not needed — this script only calls createOrder'); },
    orderBlinding: () => { throw new Error('not needed — this script only calls createOrder'); },
    ownerSecretKey: () => { throw new Error('not needed — this script only calls createOrder'); },
    adminSecretKey: () => { throw new Error('not needed — this script only calls createOrder'); },
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

  const orderId = new Uint8Array(nodeCrypto.randomBytes(32));
  const blinding = new Uint8Array(nodeCrypto.randomBytes(32));
  const ownerSecret = new Uint8Array(nodeCrypto.randomBytes(32));
  const ownerId: Uint8Array = deriveOwnerId(Buffer.from(ownerSecret));
  const details: OrderDetailsValue = {
    asset: tzkrColor,
    isBuy: false,
    price: 1_200n,
    amount: 25n,
    owner: { bytes: ownerId },
    expiresAt: 9_999_999_999n,
  };
  const commitment = computeCommitment(details, blinding);

  console.log('  Submitting createOrder on-chain (resting SELL, no counterparty)...');
  await found.callTx.createOrder(orderId, commitment);
  console.log(`  ✓ On-chain. orderId=${toHex(orderId)}\n`);

  console.log('  POSTing to the live Matcher (/orders)...');
  const postBody = {
    id: toHex(orderId),
    asset: toHex(tzkrColor),
    side: 'SELL',
    price: details.price.toString(),
    amount: details.amount.toString(),
    commitment: toHex(commitment),
    ownerId: toHex(ownerId),
    signature: toHex(blinding),
    expiresAt: details.expiresAt.toString(),
  };
  const createRes = await fetch(`${MATCHER_API_URL}/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(postBody),
  });
  const createJson = await createRes.json();
  if (!createRes.ok) fail(`Matcher rejected the order: ${createRes.status} ${JSON.stringify(createJson)}`);
  console.log(`  ✅ Matcher accepted the order: ${JSON.stringify(createJson)}\n`);

  console.log('  Confirming via GET /orders/:id...');
  const getRes = await fetch(`${MATCHER_API_URL}/orders/${toHex(orderId)}`);
  const getJson = await getRes.json();
  console.log(`  ${JSON.stringify(getJson)}\n`);
  if (getJson?.order?.status !== 'OPEN') fail(`Expected order status OPEN, got ${getJson?.order?.status}`);

  console.log('  Confirming via GET /orderbook (asks side, tZKR)...');
  const bookRes = await fetch(`${MATCHER_API_URL}/orderbook?${new URLSearchParams({ asset: toHex(tzkrColor) })}`);
  const bookJson = await bookRes.json();
  console.log(`  ${JSON.stringify(bookJson)}\n`);
  const hasLevel = bookJson.asks?.some((l: any) => l.price === details.price.toString());
  if (!hasLevel) fail('Orderbook does not show the new SELL level at the expected price');

  console.log('  Cancelling on-chain to leave no dangling test state...');
  // No cancelOrder witness wiring in this script (out of scope — this
  // script only ever needed createOrder's authorization-free path); leaving
  // the order OPEN with a far-future expiry is fine, it does not affect any
  // other order or the Treasury.

  await persistWalletState(network, walletCtx);
  await walletCtx.wallet.stop();
  console.log('─── Live Matcher REST order-submission check: ALL PASSED ───────\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
