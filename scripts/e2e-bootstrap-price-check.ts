/**
 * Live, one-shot validation of the cold-start bootstrap-pricing fix against
 * a currently-running Matcher (MATCHER_API_URL, default
 * http://localhost:4000) and the real tZKR/tNIGHT Preprod deployment.
 *
 * Exercises, in order:
 *  1. A resting order with no counterparty on a virgin asset (no matches yet)
 *     gets a real PPM quote — proving MarketDataService.referencePrice()'s
 *     bootstrap fallback engaged (previously this would have returned null
 *     forever; see MarketDataService.ts's referencePrice doc comment).
 *  2. That quote is settled for real (settleWithProtocol, submitted by the
 *     order's own owner) and the order reconciles to FILLED.
 *  3. Confirms the bootstrap price is STILL PRESENT after that PPM fill —
 *     by design (see OrderService.ts's matchRepo.insert call site /
 *     BootstrapPriceRepository.clear doc comment), a PPM fill's price was
 *     itself derived FROM the bootstrap price, so it must never be treated
 *     as independent price discovery — only a genuine order<->order match
 *     (recorded in `matches`) may retire it. Asserting the bootstrap
 *     survives a PPM fill is the whole point of this step, not a bug.
 *  4. A genuine two-owner crossing order pair is submitted and matched by
 *     the Matcher's own order book — a real trade, recorded in `matches`.
 *  5. Confirms the bootstrap price is now gone (deleted the moment that
 *     match was recorded).
 *  6. A further resting order gets quoted from real market data (the match's
 *     price), not the (now-gone) bootstrap price.
 *
 * Usage: npx tsx scripts/e2e-bootstrap-price-check.ts --network preprod
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
  function bootstrapRow(): { price: string } | undefined {
    return db.prepare('SELECT price FROM bootstrap_prices WHERE asset_key = ?').get(tzkrColorHex) as
      | { price: string }
      | undefined;
  }
  function matchCount(): number {
    return (db.prepare('SELECT COUNT(*) c FROM matches WHERE asset_key = ?').get(tzkrColorHex) as { c: number }).c;
  }

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log(`║  Bootstrap-price cold-start check on ${network}`);
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const preExistingMatches = matchCount();
  console.log(`  Pre-existing matches for tZKR: ${preExistingMatches}`);
  const bootstrapBefore = bootstrapRow();
  if (!bootstrapBefore) fail('pre-check', 'No bootstrap_prices row for tZKR — run npm run set:bootstrap-price first.');
  console.log(`  Bootstrap price currently stored: ${bootstrapBefore.price}\n`);

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const zkConfigPath = path.resolve(__dirname, '..', 'contracts', 'managed', 'exchange');
  const contractPath = path.join(zkConfigPath, 'contract', 'index.js');
  if (!fs.existsSync(contractPath)) fail('setup', 'Compiled contract missing — run: npm run compile');
  const Exchange = await import(pathToFileURL(contractPath).href);
  const { deriveOwnerId } = Exchange.pureCircuits;

  const orderStore = new Map<string, { details: OrderDetailsValue; blinding: Uint8Array; ownerSecret: Uint8Array }>();
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

  function makeOrder(opts: { isBuy: boolean; price: bigint; amount: bigint; ownerSecret: Uint8Array }) {
    const orderId = new Uint8Array(nodeCrypto.randomBytes(32));
    const blinding = new Uint8Array(nodeCrypto.randomBytes(32));
    const ownerId: Uint8Array = deriveOwnerId(Buffer.from(opts.ownerSecret));
    const details: OrderDetailsValue = {
      asset: tzkrColor,
      isBuy: opts.isBuy,
      price: opts.price,
      amount: opts.amount,
      owner: { bytes: ownerId },
      expiresAt: FAR_FUTURE,
    };
    const commitment = computeCommitment(details, blinding);
    orderStore.set(toHex(orderId), { details, blinding, ownerSecret: opts.ownerSecret });
    return { orderId, commitment, details, blinding };
  }

  async function postOrder(o: ReturnType<typeof makeOrder>, side: 'BUY' | 'SELL', payoutAddress?: string) {
    const body = {
      id: toHex(o.orderId),
      asset: tzkrColorHex,
      side,
      price: o.details.price.toString(),
      amount: o.details.amount.toString(),
      commitment: toHex(o.commitment),
      ownerId: toHex(o.details.owner.bytes),
      signature: toHex(o.blinding),
      expiresAt: FAR_FUTURE.toString(),
      payoutAddress: payoutAddress ?? null,
    };
    const res = await fetch(`${MATCHER_API_URL}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    return { res, json };
  }

  // ─── Step 5/6: virgin-asset order gets a PPM quote off the bootstrap price ──
  console.log('─── Step 5/6: resting BUY order on the virgin asset ─────────────\n');
  const buyerSecret1 = new Uint8Array(nodeCrypto.randomBytes(32));
  const order1 = makeOrder({ isBuy: true, price: 1n, amount: 10n, ownerSecret: buyerSecret1 });
  console.log('  Submitting createOrder on-chain...');
  await found.callTx.createOrder(order1.orderId, order1.commitment);
  console.log('  Posting to the Matcher...');
  const { res: res1, json: json1 } = await postOrder(order1, 'BUY', ownAddressHex);
  if (!res1.ok) fail('step 5', `Matcher rejected the order: ${res1.status} ${JSON.stringify(json1)}`);
  console.log(`  Matcher response: ${JSON.stringify(json1)}\n`);
  if (!json1.pendingProtocolQuote) {
    fail(
      'step 6 — matcher/src/ppm/PPMService.ts attemptFill / matcher/src/ppm/PricingEngine.ts quote',
      `Expected a pendingProtocolQuote (PricingEngine should have quoted off the bootstrap price) but got: ${JSON.stringify(json1)}`,
    );
  }
  console.log(`  ✅ Step 6 PASS: PricingEngine returned a quote (price=${json1.pendingProtocolQuote.price}) sourced from the bootstrap price.\n`);

  // ─── Step 7: complete wallet settlement (settleWithProtocol) ───────────────
  console.log('─── Step 7: complete wallet settlement ──────────────────────────\n');
  activeOwnerSecret = buyerSecret1;
  const recipientAddressBytes = encodeUserAddress(ownAddressHex);
  const recipient = { is_left: false, left: { bytes: new Uint8Array(32) }, right: { bytes: recipientAddressBytes } };
  const quoteId1 = Buffer.from(json1.pendingProtocolQuote.quoteId, 'hex');
  console.log('  Submitting settleWithProtocol...');
  await found.callTx.settleWithProtocol(order1.orderId, quoteId1, recipient);

  let reconciled: any;
  for (let i = 0; i < 10; i++) {
    const r = await fetch(`${MATCHER_API_URL}/orders/${toHex(order1.orderId)}`);
    reconciled = await r.json();
    if (reconciled?.order?.status === 'FILLED') break;
    await new Promise((r2) => setTimeout(r2, 3000));
  }
  if (reconciled?.order?.status !== 'FILLED') {
    fail(
      'step 7 — matcher/src/services/OrderService.ts reconcileProtocolFill',
      `Expected order status FILLED after settlement + reconciliation, got: ${JSON.stringify(reconciled)}`,
    );
  }
  console.log(`  ✅ Step 7 PASS: order reconciled to FILLED.\n`);

  // ─── Step 8/9 (as actually designed): bootstrap survives a PPM fill, ───────
  // is retired only by a genuine order<->order match ──────────────────────
  console.log('─── Step 8/9: bootstrap-price retirement semantics ──────────────\n');
  const afterPpmFill = bootstrapRow();
  if (!afterPpmFill) {
    fail(
      'step 9 (unexpected-early) — matcher/src/services/OrderService.ts (bootstrapPriceRepo.clear call site)',
      'Bootstrap price was removed after a PPM fill. This is a correctness bug: a PPM fill\'s price is DERIVED from the bootstrap price, not independent price discovery, so retiring it here would recreate the cold-start deadlock for the next order on this asset.',
    );
  }
  console.log(`  ✓ Bootstrap price still present after the PPM fill (as designed): ${afterPpmFill.price}\n`);

  const matchesAfterPpm = matchCount();
  if (matchesAfterPpm !== preExistingMatches) {
    fail(
      'step 8 (unexpected) — matcher/src/services/OrderService.ts (matchRepo.insert call site)',
      `A PPM/protocol fill should NOT be recorded in matches (only user<->user matches are) — count went from ${preExistingMatches} to ${matchesAfterPpm}.`,
    );
  }
  console.log(`  ✓ matches table unchanged by the PPM fill (${matchesAfterPpm}), as designed — a PPM fill is not "the first trade" for reference-price purposes.\n`);

  console.log('  Submitting a genuine two-owner crossing order pair (the real "first trade")...');
  const sellerSecret = new Uint8Array(nodeCrypto.randomBytes(32));
  const buyerSecret2 = new Uint8Array(nodeCrypto.randomBytes(32));
  const sellOrder = makeOrder({ isBuy: false, price: 3n, amount: 7n, ownerSecret: sellerSecret });
  const buyOrder = makeOrder({ isBuy: true, price: 5n, amount: 7n, ownerSecret: buyerSecret2 });

  await found.callTx.createOrder(sellOrder.orderId, sellOrder.commitment);
  const { res: resSell, json: jsonSell } = await postOrder(sellOrder, 'SELL');
  if (!resSell.ok) fail('step 9 setup', `Matcher rejected the resting SELL: ${resSell.status} ${JSON.stringify(jsonSell)}`);

  await found.callTx.createOrder(buyOrder.orderId, buyOrder.commitment);
  const { res: resBuy, json: jsonBuy } = await postOrder(buyOrder, 'BUY');
  if (!resBuy.ok) fail('step 9 setup', `Matcher rejected the crossing BUY: ${resBuy.status} ${JSON.stringify(jsonBuy)}`);
  if (!jsonBuy.match) {
    fail(
      'step 9 setup — matcher/src/matcher/MatchingEngine.ts',
      `Expected the two crossing orders to match immediately, got: ${JSON.stringify(jsonBuy)}`,
    );
  }
  console.log(`  ✅ Real order<->order match recorded: ${JSON.stringify(jsonBuy.match)}\n`);

  const matchesAfterReal = matchCount();
  if (matchesAfterReal !== preExistingMatches + 1) {
    fail('step 9 setup', `Expected matches count to increase by exactly 1, went from ${preExistingMatches} to ${matchesAfterReal}.`);
  }

  const bootstrapAfterRealMatch = bootstrapRow();
  if (bootstrapAfterRealMatch) {
    fail(
      'step 9 — matcher/src/services/OrderService.ts (bootstrapPriceRepo.clear call site)',
      `Expected the bootstrap_prices row for tZKR to be deleted after the first real match, but it is still present: ${JSON.stringify(bootstrapAfterRealMatch)}`,
    );
  }
  console.log('  ✅ Step 9 PASS: bootstrap price automatically removed after the first genuine order<->order match.\n');

  // Settle this pair too, so it does not sit MATCHED forever (best-effort, does not affect the assertions above).
  activeOwnerSecret = sellerSecret;
  try {
    await found.callTx.settle(buyOrder.orderId, sellOrder.orderId);
  } catch (e) {
    console.log(`  (non-fatal: settle() of the test pair did not land: ${e})`);
  }

  // ─── Step 10: next resting order is now quoted from real market data ───────
  console.log('─── Step 10: pricing now comes from market data, not bootstrap ──\n');
  const buyerSecret3 = new Uint8Array(nodeCrypto.randomBytes(32));
  const order3 = makeOrder({ isBuy: true, price: 10n, amount: 1n, ownerSecret: buyerSecret3 });
  await found.callTx.createOrder(order3.orderId, order3.commitment);
  const { res: res3, json: json3 } = await postOrder(order3, 'BUY', ownAddressHex);
  if (!res3.ok) fail('step 10', `Matcher rejected the order: ${res3.status} ${JSON.stringify(json3)}`);
  console.log(`  Matcher response: ${JSON.stringify(json3)}\n`);
  if (!json3.pendingProtocolQuote) {
    fail('step 10', `Expected a PPM quote sourced from real market data, got: ${JSON.stringify(json3)}`);
  }
  console.log(`  ✅ Step 10 PASS: quote price=${json3.pendingProtocolQuote.price} — no bootstrap row exists anymore, so this is necessarily sourced from lastPrice/book mid, not bootstrap.\n`);

  await persistWalletState(network, walletCtx);
  await walletCtx.wallet.stop();
  db.close();
  console.log('─── Bootstrap-price cold-start check: ALL STEPS PASSED ──────────\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
