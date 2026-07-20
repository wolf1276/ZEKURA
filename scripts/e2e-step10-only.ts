/**
 * Resumes the bootstrap-price cold-start check from Step 10 only (see
 * scripts/e2e-bootstrap-price-check.ts) — does not touch the DB, the
 * matcher, or the existing bootstrap/match state. Submits exactly one more
 * resting order (no counterparty) and confirms the PPM quote is now sourced
 * from real market data, not the (already-retired) bootstrap price.
 *
 * Usage: npx tsx scripts/e2e-step10-only.ts --network preprod
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as nodeCrypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import * as rt from '@midnight-ntwrk/compact-runtime';
import Database from 'better-sqlite3';

import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { encodeUserAddress } from '@midnight-ntwrk/ledger-v8';
import { getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { MidnightBech32m, UnshieldedAddress } from '@midnight-ntwrk/wallet-sdk-address-format';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { resolveNetwork, getOrCreateSeed, getDeployment, getOrCreateAdminSecret } from '../src/network.js';
import { createWallet, persistWalletState } from '../src/wallet.js';
import { getTzkrDeployment } from '../src/tzkr-state.js';
import type { Contract as ExchangeContract } from '../contracts/managed/exchange/contract/index.js';

// @ts-expect-error Required for wallet sync
globalThis.WebSocket = WebSocket;

function fail(step: string, msg: string): never {
  console.error(`\n❌ FAIL at ${step}\n${msg}\n`);
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
const MATCHER_API_URL = (process.env.MATCHER_API_URL?.trim() || 'http://localhost:4000').replace(/\/$/, '');

async function main() {
  const deployment = getDeployment(network);
  if (!deployment) fail('setup', `No exchange deployment recorded for ${network}.`);
  const tzkr = getTzkrDeployment(network);
  if (!tzkr?.color) fail('setup', `No tZKR color recorded for ${network}.`);
  const tzkrColor = Buffer.from(tzkr!.color!, 'hex');
  const tzkrColorHex = tzkr!.color!;

  const dbPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'matcher', 'data', 'matcher.db');
  const db = new Database(dbPath, { readonly: true });
  const bootstrapBefore = db.prepare('SELECT * FROM bootstrap_prices WHERE asset_key = ?').get(tzkrColorHex);
  const realMatches = db.prepare('SELECT * FROM matches WHERE asset_key = ? ORDER BY matched_at DESC').all(tzkrColorHex) as Array<{ price: string }>;

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log(`║  Step 10 only: pricing from market data on ${network}`);
  console.log('╚══════════════════════════════════════════════════════════════╝\n');
  console.log(`  bootstrap_prices row for tZKR: ${bootstrapBefore ? JSON.stringify(bootstrapBefore) : '(none)'}`);
  console.log(`  matches for tZKR: ${JSON.stringify(realMatches)}\n`);
  if (bootstrapBefore) fail('pre-check', 'Expected no bootstrap_prices row (should already be retired) — aborting to avoid re-verifying an already-confirmed state incorrectly.');
  if (realMatches.length === 0) fail('pre-check', 'Expected at least one real match already recorded — aborting.');
  const expectedLastPrice = realMatches[0].price;

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const zkConfigPath = path.resolve(__dirname, '..', 'contracts', 'managed', 'exchange');
  const contractPath = path.join(zkConfigPath, 'contract', 'index.js');
  if (!fs.existsSync(contractPath)) fail('setup', 'Compiled contract missing — run: npm run compile');
  const Exchange = await import(pathToFileURL(contractPath).href);
  const { deriveOwnerId } = Exchange.pureCircuits;

  const orderStore = new Map<string, { details: OrderDetailsValue; blinding: Uint8Array }>();
  let activeOwnerSecret = new Uint8Array(32);
  const exchangeWitnesses = {
    orderDetails: (context: any, orderId: Uint8Array) => {
      const entry = orderStore.get(toHex(orderId));
      if (!entry) throw new Error('no witness data for this order');
      return [context.privateState, entry.details];
    },
    orderBlinding: (context: any, orderId: Uint8Array) => {
      const entry = orderStore.get(toHex(orderId));
      if (!entry) throw new Error('no witness data for this order');
      return [context.privateState, entry.blinding];
    },
    ownerSecretKey: (context: any) => [context.privateState, activeOwnerSecret],
    adminSecretKey: (context: any) => [context.privateState, Buffer.from(getOrCreateAdminSecret(network), 'hex')],
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

  const ownBech32 = walletCtx.unshieldedKeystore.getBech32Address().toString();
  const ownAddressHex = MidnightBech32m.parse(ownBech32).decode(UnshieldedAddress, getNetworkId()).hexString;
  const FAR_FUTURE = 9_999_999_999n;

  const ownerSecret = new Uint8Array(nodeCrypto.randomBytes(32));
  const orderId = new Uint8Array(nodeCrypto.randomBytes(32));
  const blinding = new Uint8Array(nodeCrypto.randomBytes(32));
  const ownerId: Uint8Array = deriveOwnerId(Buffer.from(ownerSecret));
  const details: OrderDetailsValue = {
    asset: tzkrColor,
    isBuy: true,
    price: 10n,
    amount: 1n,
    owner: { bytes: ownerId },
    expiresAt: FAR_FUTURE,
  };
  const commitment = computeCommitment(details, blinding);
  orderStore.set(toHex(orderId), { details, blinding });

  console.log('─── Step 10: resting BUY order, market data already exists ──────\n');
  console.log('  Submitting createOrder on-chain...');
  await found.callTx.createOrder(orderId, commitment);

  console.log('  Posting to the Matcher...');
  const body = {
    id: toHex(orderId),
    asset: tzkrColorHex,
    side: 'BUY',
    price: details.price.toString(),
    amount: details.amount.toString(),
    commitment: toHex(commitment),
    ownerId: toHex(ownerId),
    signature: toHex(blinding),
    expiresAt: FAR_FUTURE.toString(),
    payoutAddress: ownAddressHex,
  };
  const res = await fetch(`${MATCHER_API_URL}/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) fail('step 10', `Matcher rejected the order: ${res.status} ${JSON.stringify(json)}`);
  console.log(`  Matcher response: ${JSON.stringify(json)}\n`);

  if (!json.pendingProtocolQuote) fail('step 10', `Expected a PPM quote, got: ${JSON.stringify(json)}`);
  if (json.pendingProtocolQuote.price !== expectedLastPrice) {
    fail(
      'step 10 — matcher/src/services/MarketDataService.ts referencePrice()',
      `Expected the quote price to derive from lastPrice=${expectedLastPrice}, got ${json.pendingProtocolQuote.price}`,
    );
  }
  console.log(`  ✅ Quote price (${json.pendingProtocolQuote.price}) matches the real last-trade price (${expectedLastPrice}) — sourced from market data, not bootstrap.\n`);

  console.log('  Submitting settleWithProtocol (completing settlement)...');
  activeOwnerSecret = ownerSecret;
  const recipientAddressBytes = encodeUserAddress(ownAddressHex);
  const recipient = { is_left: false, left: { bytes: new Uint8Array(32) }, right: { bytes: recipientAddressBytes } };
  const quoteId = Buffer.from(json.pendingProtocolQuote.quoteId, 'hex');
  await found.callTx.settleWithProtocol(orderId, quoteId, recipient);

  let reconciled: any;
  for (let i = 0; i < 10; i++) {
    const r = await fetch(`${MATCHER_API_URL}/orders/${toHex(orderId)}`);
    reconciled = await r.json();
    if (reconciled?.order?.status === 'FILLED') break;
    await new Promise((r2) => setTimeout(r2, 3000));
  }
  if (reconciled?.order?.status !== 'FILLED') fail('step 10 settlement', `Expected FILLED, got: ${JSON.stringify(reconciled)}`);
  console.log('  ✅ Settlement succeeded — order reconciled to FILLED.\n');

  const bootstrapAfter = db.prepare('SELECT * FROM bootstrap_prices WHERE asset_key = ?').get(tzkrColorHex);
  if (bootstrapAfter) fail('final check', `bootstrap_prices row reappeared unexpectedly: ${JSON.stringify(bootstrapAfter)}`);
  console.log('  ✅ bootstrap_prices remains empty — no bootstrap logic was exercised.\n');

  await persistWalletState(network, walletCtx);
  await walletCtx.wallet.stop();
  db.close();
  console.log('─── Step 10: PASSED ──────────────────────────────────────────────\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
