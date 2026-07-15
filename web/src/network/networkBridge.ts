/**
 * Coordination point between the Network Manager (NetworkProvider) and the
 * Wallet Manager (WalletProvider) — deliberately a plain module, not React
 * context, because the two providers are nested (NetworkProvider wraps
 * WalletProvider in app/layout.tsx) and a parent cannot read a context
 * provided by its own child. This module is the one place that crosses that
 * boundary in both directions:
 *
 *  - App -> wallet: NetworkProvider calls `requestWalletNetworkSwitch(id)`
 *    when the user picks a network while a wallet is connected. WalletProvider
 *    registers the real implementation via `setWalletNetworkBridge`.
 *  - Wallet -> app: WalletProvider calls `emitWalletNetworkChanged(id)` any
 *    time it observes (via connect or poll — the DApp Connector v4.0.1 API has
 *    no push events for this, confirmed via the Midnight docs MCP) that the
 *    connected wallet's actual network differs from what was last reported.
 *    NetworkProvider subscribes via `onWalletNetworkChanged` and adopts the
 *    wallet's network as the app's single source of truth.
 *
 * The wallet's confirmed network is always the ground truth; `requestSwitch`'s
 * returned Promise only ever signals success/failure of the attempt, never
 * carries the confirmed id itself — that always arrives through
 * `emitWalletNetworkChanged`, so there is exactly one code path that ever
 * assigns the app's active network (see NetworkProvider.tsx).
 */
import type { NetworkId } from "./networkConfig";

export class NoWalletConnectedError extends Error {
  constructor() {
    super("No wallet connected.");
    this.name = "NoWalletConnectedError";
  }
}

export interface WalletNetworkBridge {
  /**
   * Ask the connected wallet to switch to `id`. Resolves once the wallet has
   * confirmed the switch (the confirmed network id itself is delivered
   * separately via `emitWalletNetworkChanged`, not this promise's value).
   * Rejects with `NoWalletConnectedError` if no wallet is connected — callers
   * should treat that as "nothing to confirm, just update the preference".
   * Rejects with any other `Error` if the wallet rejected, timed out, or the
   * switch otherwise failed.
   */
  requestSwitch(id: NetworkId): Promise<void>;
}

type WalletNetworkListener = (walletNetworkId: string) => void;

let bridge: WalletNetworkBridge | null = null;
const listeners = new Set<WalletNetworkListener>();

/** Called by WalletProvider on mount/unmount to (un)register the live implementation. */
export function setWalletNetworkBridge(impl: WalletNetworkBridge | null): void {
  bridge = impl;
}

export function requestWalletNetworkSwitch(id: NetworkId): Promise<void> {
  if (!bridge) return Promise.reject(new NoWalletConnectedError());
  return bridge.requestSwitch(id);
}

/** Called by NetworkProvider to learn about wallet-confirmed network changes, whether app-requested or spontaneous (changed inside the wallet's own UI). */
export function onWalletNetworkChanged(listener: WalletNetworkListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Called by WalletProvider every time a fresh wallet read reports a network id different from the last one it reported. */
export function emitWalletNetworkChanged(walletNetworkId: string): void {
  for (const listener of listeners) listener(walletNetworkId);
}

// A network switch must never silently cut off a transaction that's
// mid-flight in the wallet (balance/sign/submit) — tracked here rather than
// in either provider's state so both the trade hook (use-submit-order.ts)
// and the Network Manager's switch entry point can reach it without a prop
// or context path between two components that aren't ancestor/descendant of
// each other.
let pendingTxCount = 0;

export function setTxPending(pending: boolean): void {
  pendingTxCount += pending ? 1 : -1;
  if (pendingTxCount < 0) pendingTxCount = 0;
}

export function isTxPending(): boolean {
  return pendingTxCount > 0;
}
