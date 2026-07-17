// Wallet construction + sync-state restore.
//
// Mirrors network.ts in structure. The on-disk format and pure I/O live in
// wallet-state.ts (unit-tested from the scaffolder workspace, no SDK deps);
// this file is the glue between that format and the wallet SDK.

import { Buffer } from 'buffer';
import * as crypto from 'node:crypto';

import * as Rx from 'rxjs';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import { unshieldedToken } from '@midnight-ntwrk/ledger-v8';
import { setNetworkId, getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { NoOpTransactionHistoryStorage } from '@midnightntwrk/wallet-sdk-abstractions';
import { WalletFacade } from '@midnightntwrk/wallet-sdk-facade';
import { DustWallet } from '@midnightntwrk/wallet-sdk-dust-wallet';
import { HDWallet, Roles } from '@midnightntwrk/wallet-sdk-hd';
import { ShieldedWallet } from '@midnightntwrk/wallet-sdk-shielded';
import {
  createKeystore,
  PublicKey,
  UnshieldedWallet,
} from '@midnightntwrk/wallet-sdk-unshielded-wallet';

import type { NetworkConfig, NetworkId } from './network.js';
import {
  CHILD_KINDS,
  loadWalletState,
  saveWalletState,
  type ChildKind,
  type PersistedWalletState,
} from './wallet-state.js';

export { unshieldedToken };
export type { PersistedWalletState };
export {
  loadWalletState,
  saveWalletState,
  clearWalletState,
  WALLET_STATE_DIR,
  WALLET_STATE_VERSION,
} from './wallet-state.js';

function deriveKeys(seed: string) {
  const hdWallet = HDWallet.fromSeed(Buffer.from(seed, 'hex'));
  if (hdWallet.type !== 'seedOk') throw new Error('Invalid seed');
  const result = hdWallet.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);
  if (result.type !== 'keysDerived') throw new Error('Key derivation failed');
  hdWallet.hdWallet.clear();
  return result.keys;
}

export interface WalletContext {
  wallet: Awaited<ReturnType<typeof WalletFacade.init>>;
  shieldedSecretKeys: ReturnType<typeof ledger.ZswapSecretKeys.fromSeed>;
  dustSecretKey: ReturnType<typeof ledger.DustSecretKey.fromSeed>;
  unshieldedKeystore: ReturnType<typeof createKeystore>;
  restored: { shielded: boolean; unshielded: boolean; dust: boolean };
  /** sha256(seed) hex — carried through so persistWalletState can tag whatever it saves with the seed that actually owns it. See wallet-state.ts's PersistedWalletState.seedFingerprint. */
  seedFingerprint: string;
}

function fingerprintSeed(seed: string): string {
  return crypto.createHash('sha256').update(seed, 'hex').digest('hex');
}

export interface CreateWalletOptions {
  network: NetworkId;
  networkConfig: NetworkConfig;
  seed: string;
  /**
   * Whether to attempt to restore each child wallet from saved state.
   * Defaults to true. Pass false to force a from-seed sync (used by tests).
   */
  restore?: boolean;
  cwd?: string;
}

function warnRestoreFailure(kind: ChildKind, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`  ⚠ Could not restore ${kind} wallet state (${msg}); falling back to fresh sync.\n`);
}

/**
 * Build the wallet facade, restoring each child from saved state when
 * available and falling back to a from-seed start when not (or when restore
 * throws, e.g. after an SDK upgrade with an incompatible state format).
 *
 * Caller is responsible for `await wallet.waitForSyncedState()` afterwards.
 */
export async function createWallet(opts: CreateWalletOptions): Promise<WalletContext> {
  setNetworkId(opts.networkConfig.networkId);

  const keys = deriveKeys(opts.seed);
  const networkId = getNetworkId();
  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);
  const unshieldedKeystore = createKeystore(keys[Roles.NightExternal], networkId);

  const seedFingerprint = fingerprintSeed(opts.seed);
  const loaded: PersistedWalletState = opts.restore === false
    ? {}
    : loadWalletState(opts.network, { cwd: opts.cwd });
  // A cache directory on disk can outlive the seed it was captured for —
  // e.g. .midnight-state.json (which holds the real seed) is lost or
  // regenerated while .midnight-wallet-state/<network>/ (gitignored,
  // survives independently) is not. Restoring that stale state produces a
  // wallet that *reports* balances/UTXOs it cannot actually sign for, since
  // signing uses the keys derived from the *current* seed — this is not
  // hypothetical, it's exactly what "attempted to spend Dust UTXO that's
  // not in the wallet state" means when it happens. An absent fingerprint
  // (old-format cache from before this check existed) is treated the same
  // as a mismatch: untrusted, never assumed valid.
  const fingerprintMatches = loaded.seedFingerprint === seedFingerprint;
  if (!fingerprintMatches && (loaded.shielded !== undefined || loaded.unshielded !== undefined || loaded.dust !== undefined)) {
    process.stderr.write(
      `  ⚠ .midnight-wallet-state/${opts.network} does not match this seed (stale cache from a different wallet); ignoring it and starting a fresh sync.\n`,
    );
  }
  const saved: PersistedWalletState = fingerprintMatches ? loaded : {};

  const restored = { shielded: false, unshielded: false, dust: false };

  const walletConfig = {
    networkId,
    indexerClientConnection: {
      indexerHttpUrl: opts.networkConfig.indexer,
      indexerWsUrl: opts.networkConfig.indexerWS,
    },
    provingServerUrl: new URL(opts.networkConfig.proofServer),
    relayURL: new URL(opts.networkConfig.node.replace(/^http/, 'ws')),
    txHistoryStorage: new NoOpTransactionHistoryStorage(),
    costParameters: { additionalFeeOverhead: 300_000_000_000_000n, feeBlocksMargin: 5 },
  };

  const wallet = await WalletFacade.init({
    configuration: walletConfig,
    shielded: async (config) => {
      const cls = ShieldedWallet(config);
      if (saved.shielded !== undefined) {
        try {
          const restoredWallet = await (cls as any).restore(saved.shielded);
          restored.shielded = true;
          return restoredWallet;
        } catch (err) {
          warnRestoreFailure('shielded', err);
        }
      }
      return cls.startWithSecretKeys(shieldedSecretKeys);
    },
    unshielded: async (config) => {
      const cls = UnshieldedWallet(config);
      if (saved.unshielded !== undefined) {
        try {
          const restoredWallet = await (cls as any).restore(saved.unshielded);
          restored.unshielded = true;
          return restoredWallet;
        } catch (err) {
          warnRestoreFailure('unshielded', err);
        }
      }
      return cls.startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore));
    },
    dust: async (config) => {
      const cls = DustWallet(config);
      if (saved.dust !== undefined) {
        try {
          const restoredWallet = await (cls as any).restore(saved.dust);
          restored.dust = true;
          return restoredWallet;
        } catch (err) {
          warnRestoreFailure('dust', err);
        }
      }
      return cls.startWithSecretKey(dustSecretKey, ledger.LedgerParameters.initialParameters().dust);
    },
  });

  await wallet.start(shieldedSecretKeys, dustSecretKey);

  return { wallet, shieldedSecretKeys, dustSecretKey, unshieldedKeystore, restored, seedFingerprint };
}

/**
 * Serialize each child wallet's current state and persist it for the next run.
 * Safe to call multiple times. Logs but does not throw on individual failures —
 * losing one child's state means the next run re-syncs that child only.
 */
export async function persistWalletState(
  network: NetworkId,
  ctx: WalletContext,
  cwd?: string,
): Promise<void> {
  const next: PersistedWalletState = {};

  for (const kind of CHILD_KINDS) {
    try {
      const child = (ctx.wallet as unknown as Record<ChildKind, { serializeState: () => Promise<unknown> }>)[kind];
      const serialized = await child.serializeState();
      if (kind === 'dust') {
        next.dust = serialized as string;
      } else {
        next[kind] = serialized;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`  ⚠ Could not serialize ${kind} wallet state (${msg}); next run will re-sync.\n`);
    }
  }

  next.seedFingerprint = ctx.seedFingerprint;
  saveWalletState(network, next, { cwd });
}

/**
 * Periodically persist wallet state while a long sync is in flight.
 *
 * A from-genesis sync against a long-lived remote chain (e.g. a first-ever
 * Preprod sync) can run for many minutes and, on memory-constrained hosts,
 * can be killed (OOM) before it ever reaches `waitForSyncedState()` — the
 * only point at which the normal call flow persists state. Without an
 * in-flight checkpoint, every retry re-syncs from block zero. Subscribing to
 * `wallet.state()` and saving on a throttle turns that into incremental
 * progress: each run resumes from the last checkpoint instead of genesis.
 */
export function startCheckpointing(
  network: NetworkId,
  ctx: WalletContext,
  opts: { intervalMs?: number; cwd?: string } = {},
): { stop: () => void } {
  const intervalMs = opts.intervalMs ?? 30_000;
  const subscription = ctx.wallet
    .state()
    .pipe(Rx.throttleTime(intervalMs))
    .subscribe({
      next: () => {
        persistWalletState(network, ctx, opts.cwd).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`  ⚠ Periodic checkpoint failed (${msg}); continuing.\n`);
        });
      },
    });
  return { stop: () => subscription.unsubscribe() };
}
