/**
 * Live end-to-end trade validation against the redeployed Exchange contract
 * on Preprod, exercising the real tZKR unshielded color end to end (not
 * simulated — every step below is a real on-chain transaction).
 *
 * Two passes, one wallet (this script's own — the Preprod deployer/admin
 * wallet, which the Treasury was just seeded from):
 *
 * 1. User<->user trade: two orders (BUY tZKR @1000, SELL tZKR @900, distinct
 *    owner secrets — settle()'s only funds-independent check is that the two
 *    orders commit to different owners) both created on-chain, then settled
 *    directly by this script (standing in for the Matcher's own settle()
 *    call — settle() itself never moves funds, it only finalizes both
 *    orders' state, so which party submits it is irrelevant).
 * 2. Protocol-liquidity trade: a single resting BUY tZKR order reserved
 *    against the Treasury's just-seeded tZKR balance via reserveLiquidity,
 *    then finished with a real settleWithProtocol call from this script
 *    acting as the order's own owner (the "Approve Settlement" step
 *    hooks/use-order-actions.ts now submits from the browser) — proves the
 *    Treasury actually pays out real tZKR and collects real NIGHT.
 *
 * Usage: npx tsx scripts/e2e-trade-check.ts --network preprod
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

// ─── OrderDetails wire encoding (same as tests/exchange.test.ts) ──────────
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

  // In-memory registry of this script's own orders, so the
  // orderDetails/orderBlinding/ownerSecretKey witnesses can serve back
  // whichever order a later circuit call (settle/settleWithProtocol) needs
  // to re-verify — exactly the role a real wallet's own private storage
  // plays (see web/src/services/midnight/orderStore.ts).
  const orderStore = new Map<string, { details: OrderDetailsValue; blinding: Uint8Array; ownerSecret: Uint8Array }>();
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
    // S1 fix: reserveLiquidity/releaseLiquidity are now requireAdmin()-gated.
    // Same admin secret the Matcher already holds for depositTreasury/
    // withdrawTreasury (see getOrCreateAdminSecret / SettlementClient.ts).
    adminSecretKey: (context: any) => [context.privateState, Buffer.from(getOrCreateAdminSecret(network), 'hex')],
  };
  const compiledContractBase = CompiledContract.make<ExchangeContract<undefined>>('exchange', Exchange.Contract);
  const compiledContractWithWitnesses = CompiledContract.withWitnesses(compiledContractBase, exchangeWitnesses);
  const compiledContract = CompiledContract.withCompiledFileAssets(compiledContractWithWitnesses, zkConfigPath);

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log(`║  Live end-to-end trade validation on ${network}`);
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

  function makeOrder(opts: { isBuy: boolean; price: bigint; amount: bigint; ownerSecret: Uint8Array; expiresAt: bigint }) {
    const orderId = new Uint8Array(nodeCrypto.randomBytes(32));
    const blinding = new Uint8Array(nodeCrypto.randomBytes(32));
    const ownerId: Uint8Array = deriveOwnerId(Buffer.from(opts.ownerSecret));
    const details: OrderDetailsValue = {
      asset: tzkrColor,
      isBuy: opts.isBuy,
      price: opts.price,
      amount: opts.amount,
      owner: { bytes: ownerId },
      expiresAt: opts.expiresAt,
    };
    const commitment = computeCommitment(details, blinding);
    orderStore.set(Buffer.from(orderId).toString('hex'), { details, blinding, ownerSecret: opts.ownerSecret });
    return { orderId, commitment, details, blinding };
  }

  const FAR_FUTURE = 9_999_999_999n;

  // ─── Pass 1: user<->user trade ──────────────────────────────────────────
  console.log('─── Pass 1: user<->user trade (real tZKR asset) ────────────────\n');
  const buyerSecret = new Uint8Array(nodeCrypto.randomBytes(32));
  const sellerSecret = new Uint8Array(nodeCrypto.randomBytes(32));

  const buy = makeOrder({ isBuy: true, price: 1_000n, amount: 50n, ownerSecret: buyerSecret, expiresAt: FAR_FUTURE });
  const sell = makeOrder({ isBuy: false, price: 900n, amount: 50n, ownerSecret: sellerSecret, expiresAt: FAR_FUTURE });

  console.log('  Submitting createOrder (BUY)...');
  await found.callTx.createOrder(buy.orderId, buy.commitment);
  console.log('  Submitting createOrder (SELL)...');
  await found.callTx.createOrder(sell.orderId, sell.commitment);

  console.log('  Submitting settle()...');
  await found.callTx.settle(buy.orderId, sell.orderId);

  const l1 = await ledger();
  const buyRecord = l1.orders.lookup(buy.orderId);
  const sellRecord = l1.orders.lookup(sell.orderId);
  if (buyRecord.state !== 1 || sellRecord.state !== 1) {
    fail(`Pass 1: expected both orders FILLED (state 1), got buy=${buyRecord.state} sell=${sellRecord.state}`);
  }
  console.log('  ✅ Pass 1: both orders independently confirmed FILLED on-chain.\n');

  // ─── Pass 2: protocol-liquidity trade (real Treasury tZKR + NIGHT) ─────
  console.log('─── Pass 2: protocol-liquidity trade (settleWithProtocol) ──────\n');
  const before = await ledger();
  const beforeTzkr = before.treasuryBalances.member(tzkrColor) ? before.treasuryBalances.lookup(tzkrColor) : 0n;
  const nightKey = new Uint8Array(32);
  const beforeNight = before.treasuryBalances.member(nightKey) ? before.treasuryBalances.lookup(nightKey) : 0n;
  console.log(`  Treasury before: tZKR=${beforeTzkr}  NIGHT=${beforeNight}`);

  const buyerSecret2 = new Uint8Array(nodeCrypto.randomBytes(32));
  const PPM_PRICE = 950n; // must sit between the reservation's quoted price and this order's own limit — reserveLiquidity below quotes exactly this price, so the crossing check (order.price >= quote.price) holds.
  const PPM_AMOUNT = 100n;
  const order2 = makeOrder({ isBuy: true, price: PPM_PRICE, amount: PPM_AMOUNT, ownerSecret: buyerSecret2, expiresAt: FAR_FUTURE });

  console.log('  Submitting createOrder (resting BUY, no counterparty)...');
  await found.callTx.createOrder(order2.orderId, order2.commitment);

  const quoteId = new Uint8Array(nodeCrypto.randomBytes(32));
  console.log('  Submitting reserveLiquidity (standing in for the Matcher\'s PPM reservation)...');
  await found.callTx.reserveLiquidity(quoteId, tzkrColor, PPM_AMOUNT, PPM_PRICE, FAR_FUTURE);

  // The "Approve Settlement" step — this script now acts as order2's own
  // owner (activeOwnerSecret), submitting settleWithProtocol with its own
  // real unshielded address as the payout recipient. Mirrors
  // hooks/use-order-actions.ts's settleWithProtocol exactly.
  activeOwnerSecret = buyerSecret2;
  const ownBech32 = walletCtx.unshieldedKeystore.getBech32Address().toString();
  const ownAddressHex = MidnightBech32m.parse(ownBech32).decode(UnshieldedAddress, getNetworkId()).hexString;
  const recipientAddressBytes = encodeUserAddress(ownAddressHex);
  const recipient = { is_left: false, left: { bytes: new Uint8Array(32) }, right: { bytes: recipientAddressBytes } };

  console.log('  Submitting settleWithProtocol (Approve Settlement)...');
  await found.callTx.settleWithProtocol(order2.orderId, quoteId, recipient);

  const after = await ledger();
  const orderRecord2 = after.orders.lookup(order2.orderId);
  const afterTzkr = after.treasuryBalances.member(tzkrColor) ? after.treasuryBalances.lookup(tzkrColor) : 0n;
  const afterNight = after.treasuryBalances.member(nightKey) ? after.treasuryBalances.lookup(nightKey) : 0n;
  console.log(`  Treasury after:  tZKR=${afterTzkr}  NIGHT=${afterNight}`);

  if (orderRecord2.state !== 1) fail(`Pass 2: expected order FILLED (state 1), got ${orderRecord2.state}`);
  if (afterTzkr !== beforeTzkr - PPM_AMOUNT) fail(`Pass 2: Treasury tZKR did not decrease by ${PPM_AMOUNT}: ${beforeTzkr} -> ${afterTzkr}`);
  if (afterNight <= beforeNight) fail(`Pass 2: Treasury NIGHT did not increase (buyer's payment): ${beforeNight} -> ${afterNight}`);
  console.log('  ✅ Pass 2: order FILLED, Treasury paid out real tZKR and collected real NIGHT.\n');

  await persistWalletState(network, walletCtx);
  await walletCtx.wallet.stop();
  console.log('─── Live end-to-end trade validation: ALL PASSED ───────────────\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
