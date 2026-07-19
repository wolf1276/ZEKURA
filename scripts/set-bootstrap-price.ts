/**
 * Sets an admin-supplied bootstrap reference price for tZKR by calling the
 * Matcher's real HTTP admin API (POST /admin/challenge, then POST
 * /admin/treasury/deposit with bootstrapPrice) — the same route the web
 * app's Treasury page hits (see web/src/hooks/use-admin-auth.ts), just
 * signed here with this CLI wallet's unshielded key instead of a browser
 * wallet's. Only tZKR is ever priced (see
 * matcher/src/services/MarketDataService.ts's referencePrice — tNIGHT is
 * always the payment leg, never itself quoted).
 *
 * The deposit amount is real: depositTreasury() on-chain asserts
 * `amount > 0` (contracts/exchange.compact), and it's the Matcher's own
 * operator wallet (configured server-side) that actually funds it — this
 * script's wallet only needs to be on MATCHER_ADMIN_ADDRESSES, not hold any
 * tZKR itself.
 *
 * Usage: npm run set:bootstrap-price -- --network preprod --price 1 [--amount 1] [--api http://localhost:4000]
 */
import { WebSocket } from 'ws';

import { resolveNetwork, getOrCreateSeed } from '../src/network.js';
import { createWallet, persistWalletState } from '../src/wallet.js';
import { getTzkrDeployment, TZKR_TOKEN_DECIMALS } from '../src/tzkr-state.js';

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

async function main() {
  const tzkr = getTzkrDeployment(network);
  if (!tzkr?.color) {
    console.error(`\n❌ No tZKR color recorded for ${network}. Run: npm run setup:tzkr -- --network ${network}\n`);
    process.exit(1);
  }

  const price = parseArg('price');
  if (price === undefined || !/^[0-9]+$/.test(price) || BigInt(price) <= 0n) {
    console.error('\n❌ --price is required and must be a positive integer (raw price: payment_raw = amount_raw * price, both tZKR and tNIGHT use 6 decimals, so the minimum representable ratio is 1 tZKR == 1 tNIGHT).\n');
    process.exit(1);
  }

  const amountWhole = BigInt(parseArg('amount') ?? '1');
  const amount = (amountWhole * 10n ** BigInt(TZKR_TOKEN_DECIMALS)).toString();
  const apiUrl = (parseArg('api') ?? process.env.MATCHER_API_URL ?? 'http://localhost:4000').trim().replace(/\/$/, '');

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log(`║  Set tZKR bootstrap price on ${network}`);
  console.log('╚══════════════════════════════════════════════════════════════╝\n');
  console.log(`  Matcher API:    ${apiUrl}`);
  console.log(`  tZKR color:     ${tzkr.color}`);
  console.log(`  Deposit amount: ${amountWhole.toLocaleString()} tZKR (${amount} base units)`);
  console.log(`  Bootstrap price: ${price} (raw tNIGHT per raw tZKR)\n`);

  console.log('  Creating + syncing wallet...');
  const walletCtx = await createWallet({ network, networkConfig, seed: SEED });
  await walletCtx.wallet.waitForSyncedState();
  await persistWalletState(network, walletCtx);
  const address = walletCtx.unshieldedKeystore.getAddress();
  console.log(`  ✓ Synced. Signing wallet address: ${address}\n`);

  console.log('  Requesting admin challenge...');
  const challengeRes = await fetch(`${apiUrl}/admin/challenge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address }),
  });
  if (!challengeRes.ok) {
    const body = await challengeRes.text();
    console.error(`\n❌ /admin/challenge failed (${challengeRes.status}): ${body}\n`);
    console.error(`  This wallet's address must be in the Matcher's MATCHER_ADMIN_ADDRESSES env var: ${address}\n`);
    process.exit(1);
  }
  const { nonce } = (await challengeRes.json()) as { nonce: string };

  const signature = walletCtx.unshieldedKeystore.signData(new Uint8Array(Buffer.from(nonce, 'hex')));
  const publicKey = walletCtx.unshieldedKeystore.getPublicKey();

  console.log('  Submitting deposit + bootstrap price...');
  const depositRes = await fetch(`${apiUrl}/admin/treasury/deposit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      auth: { address, publicKey, signature },
      assetKey: tzkr.color,
      amount,
      bootstrapPrice: price,
    }),
  });
  const depositBody = await depositRes.text();
  if (!depositRes.ok) {
    console.error(`\n❌ /admin/treasury/deposit failed (${depositRes.status}): ${depositBody}\n`);
    process.exit(1);
  }
  console.log(`  ✅ Done: ${depositBody}\n`);

  await persistWalletState(network, walletCtx);
  await walletCtx.wallet.stop();
  console.log('─── Bootstrap price set ─────────────────────────────────────────\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
