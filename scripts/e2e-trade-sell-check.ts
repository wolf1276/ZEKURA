/**
 * Live validation of settleWithProtocol's SELL branch specifically (the BUY
 * branch was already covered by scripts/e2e-trade-check.ts's Pass 2) —
 * the Treasury *receives* the traded asset from the seller and pays out
 * real NIGHT, the opposite direction of the BUY branch. Uses the same
 * wallet/provider setup as e2e-trade-check.ts.
 *
 * Usage: npx tsx scripts/e2e-trade-sell-check.ts --network preprod
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

const { network, config: networkConfig } = resolveNetwork();
const SEED = getOrCreateSeed(network);

async function main() {
  const deployment = getDeployment(network);
  if (!deployment) fail(`No exchange deployment recorded for ${network}.`);
  const tzkr = getTzkrDeployment(network);
  if (!tzkr?.color) fail(`No tZKR color recorded for ${network}.`);
  const tzkrColor = Buffer.from(tzkr!.color!, 'hex');

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const zkConfigPath = path.resolve(__dirname, '..', 'contracts', 'managed', 'exchange');
  const contractPath = path.join(zkConfigPath, 'contract', 'index.js');
  if (!fs.existsSync(contractPath)) fail('Compiled contract missing — run: npm run compile');
  const Exchange = await import(pathToFileURL(contractPath).href);
  const { deriveOwnerId } = Exchange.pureCircuits;

  const orderStore = new Map<string, { details: OrderDetailsValue; blinding: Uint8Array }>();
  let activeOwnerSecret = new Uint8Array(32);

  const exchangeWitnesses = {
    orderDetails: (context: any, orderId: Uint8Array) => {
      const entry = orderStore.get(Buffer.from(orderId).toString('hex'));
      if (!entry) throw new Error('no witness data for this order');
      return [context.privateState, entry.details];
    },
    orderBlinding: (context: any, orderId: Uint8Array) => {
      const entry = orderStore.get(Buffer.from(orderId).toString('hex'));
      if (!entry) throw new Error('no witness data for this order');
      return [context.privateState, entry.blinding];
    },
    ownerSecretKey: (context: any) => [context.privateState, activeOwnerSecret],
    adminSecretKey: (context: any) => {
      const adminSecretHex = getOrCreateAdminSecret(network);
      return [context.privateState, Buffer.from(adminSecretHex, 'hex')];
    },
  };
  const compiledContractBase = CompiledContract.make<ExchangeContract<undefined>>('exchange', Exchange.Contract);
  const compiledContractWithWitnesses = CompiledContract.withWitnesses(compiledContractBase, exchangeWitnesses);
  const compiledContract = CompiledContract.withCompiledFileAssets(compiledContractWithWitnesses, zkConfigPath);

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log(`║  Live settleWithProtocol SELL-branch validation on ${network}`);
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

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

  async function ledger() {
    const s = await providers.publicDataProvider.queryContractState(deployment!.address);
    return Exchange.ledger(s!.data);
  }

  const nightKey = new Uint8Array(32);
  const before = await ledger();
  const beforeTzkr = before.treasuryBalances.member(tzkrColor) ? before.treasuryBalances.lookup(tzkrColor) : 0n;
  const beforeNight = before.treasuryBalances.member(nightKey) ? before.treasuryBalances.lookup(nightKey) : 0n;
  console.log(`  Treasury before: tZKR=${beforeTzkr}  NIGHT=${beforeNight}`);

  const sellerSecret = new Uint8Array(nodeCrypto.randomBytes(32));
  const ownerId: Uint8Array = deriveOwnerId(Buffer.from(sellerSecret));
  const PRICE = 900n;
  const AMOUNT = 50n;
  const FAR_FUTURE = 9_999_999_999n;

  const orderId = new Uint8Array(nodeCrypto.randomBytes(32));
  const blinding = new Uint8Array(nodeCrypto.randomBytes(32));
  const details: OrderDetailsValue = {
    asset: tzkrColor,
    isBuy: false, // SELL
    price: PRICE,
    amount: AMOUNT,
    owner: { bytes: ownerId },
    expiresAt: FAR_FUTURE,
  };
  const commitment = computeCommitment(details, blinding);
  orderStore.set(Buffer.from(orderId).toString('hex'), { details, blinding });

  console.log('  Submitting createOrder (resting SELL, no counterparty)...');
  await found.callTx.createOrder(orderId, commitment);

  const quoteId = new Uint8Array(nodeCrypto.randomBytes(32));
  console.log('  Submitting reserveLiquidity (PPM quoting a SELL fill — protocol becomes the buyer)...');
  await found.callTx.reserveLiquidity(quoteId, tzkrColor, AMOUNT, PRICE, FAR_FUTURE);

  activeOwnerSecret = sellerSecret;
  const ownBech32 = walletCtx.unshieldedKeystore.getBech32Address().toString();
  const ownAddressHex = MidnightBech32m.parse(ownBech32).decode(UnshieldedAddress, getNetworkId()).hexString;
  const recipientAddressBytes = encodeUserAddress(ownAddressHex);
  const recipient = { is_left: false, left: { bytes: new Uint8Array(32) }, right: { bytes: recipientAddressBytes } };

  console.log('  Submitting settleWithProtocol (seller\'s own wallet supplies the tZKR input)...');
  await found.callTx.settleWithProtocol(orderId, quoteId, recipient);

  const after = await ledger();
  const orderRecord = after.orders.lookup(orderId);
  const afterTzkr = after.treasuryBalances.member(tzkrColor) ? after.treasuryBalances.lookup(tzkrColor) : 0n;
  const afterNight = after.treasuryBalances.member(nightKey) ? after.treasuryBalances.lookup(nightKey) : 0n;
  console.log(`  Treasury after:  tZKR=${afterTzkr}  NIGHT=${afterNight}`);

  if (orderRecord.state !== 1) fail(`Expected order FILLED (state 1), got ${orderRecord.state}`);
  if (afterTzkr !== beforeTzkr + AMOUNT) fail(`Treasury tZKR did not increase by ${AMOUNT} (seller's asset): ${beforeTzkr} -> ${afterTzkr}`);
  if (afterNight >= beforeNight) fail(`Treasury NIGHT did not decrease (seller's payout): ${beforeNight} -> ${afterNight}`);
  console.log(`  ✅ SELL-branch settleWithProtocol confirmed: Treasury received real tZKR (+${AMOUNT}) and paid out real NIGHT (-${beforeNight - afterNight}).\n`);

  await persistWalletState(network, walletCtx);
  await walletCtx.wallet.stop();
  console.log('─── Live SELL-branch validation: PASSED ────────────────────────\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
