/**
 * Check (and if needed, perform) DUST-generation registration for the
 * matcher's operator wallet. Same registration call deploy-tzkr.ts uses
 * (registerNightUtxosForDustGeneration) — this is a standalone diagnostic/
 * fix script, not a new flow.
 */
import { WebSocket } from 'ws';
import * as Rx from 'rxjs';

import { resolveNetwork, getOrCreateSeed } from './network';
import { createWallet, persistWalletState, unshieldedToken } from './wallet';

// @ts-expect-error Required for wallet sync
globalThis.WebSocket = WebSocket;

const { network, config: networkConfig } = resolveNetwork();
const SEED = getOrCreateSeed(network);

async function main() {
  console.log('  Building wallet...');
  const walletCtx = await createWallet({ network, networkConfig, seed: SEED });
  console.log('  Syncing with network (this may take a while)...');
  const state = await walletCtx.wallet.waitForSyncedState();

  const address = walletCtx.unshieldedKeystore.getBech32Address();
  const tNight = state.unshielded.balances[unshieldedToken().raw] ?? 0n;
  const dust = state.dust.balance(new Date());
  const nightCoins = state.unshielded.availableCoins.filter((c: any) => c.utxo?.type === unshieldedToken().raw);
  const unregistered = nightCoins.filter((c: any) => !c.meta?.registeredForDustGeneration);

  console.log(`\n  Address: ${address}`);
  console.log(`  tNight balance: ${tNight.toLocaleString()}`);
  console.log(`  DUST balance:   ${dust.toLocaleString()}`);
  console.log(`  NIGHT UTXOs: ${nightCoins.length} total, ${unregistered.length} unregistered for DUST generation\n`);

  if (unregistered.length === 0) {
    console.log(dust > 0n ? '  ✅ Already registered and DUST is flowing.' : '  ✅ Already registered — waiting on DUST to accrue.');
  } else {
    console.log(`  Registering ${unregistered.length} NIGHT UTXOs for DUST generation...`);
    const recipe = await walletCtx.wallet.registerNightUtxosForDustGeneration(
      unregistered,
      walletCtx.unshieldedKeystore.getPublicKey(),
      (payload) => walletCtx.unshieldedKeystore.signData(payload),
    );
    const finalized = await walletCtx.wallet.finalizeRecipe(recipe);
    await walletCtx.wallet.submitTransaction(finalized);
    console.log('  ✅ Registration tx submitted. DUST will begin accruing from registered NIGHT.');
  }

  await persistWalletState(network, walletCtx);
  await walletCtx.wallet.stop();
}

main().catch((err) => {
  console.error('\n❌ Error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
