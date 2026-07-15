/**
 * Discovery for the Midnight DApp Connector API (@midnight-ntwrk/dapp-connector-api
 * v4.0.1). Wallets inject an `InitialAPI` under `window.midnight`, keyed by an
 * identifier — confirmed fixed keys (per docs.midnight.network/sdks/community/wallets/
 * community-wallets-integration): `window.midnight.mnLace`, `window.midnight['1am']`.
 * Any other connector-compatible wallet injects under its own key instead and is
 * picked up generically by scanning `Object.values(window.midnight)` — nothing
 * about it needs to be known ahead of time, so a brand-new wallet just appears.
 *
 * This module is the ONLY place that knows about specific wallet brands. Everything
 * above it (WalletProvider, WalletModal) only ever touches `PickerWallet` /
 * `InitialAPI` / `ConnectedAPI`, so adding, removing, or reordering known wallets is
 * confined to `KNOWN_WALLETS` below.
 */
import type { InitialAPI } from "@midnight-ntwrk/dapp-connector-api";
import type { KnownWalletDescriptor, PickerWallet } from "./walletTypes";

export const KNOWN_WALLET_KEYS = {
  lace: "mnLace",
  oneAM: "1am",
} as const;

/**
 * Branded entries always shown in the picker, installed or not. Sourced from
 * docs.midnight.network/sdks/community/wallets/community-wallets-reference#sources:
 * 1AM (https://1am.xyz/) and Lace (https://www.lace.io/midnight) are the two
 * wallets with a documented, stable Midnight DApp Connector injection key today.
 * 1AM is listed first and marked recommended — it's shielded-by-default with
 * in-browser proving, the preferred wallet for this app.
 */
export const KNOWN_WALLETS: KnownWalletDescriptor[] = [
  {
    key: KNOWN_WALLET_KEYS.oneAM,
    name: "1AM Wallet",
    downloadUrl: "https://1am.xyz/",
    recommended: true,
  },
  {
    key: KNOWN_WALLET_KEYS.lace,
    name: "Lace",
    downloadUrl: "https://www.lace.io/midnight",
    matchName: (name) => name.toLowerCase().includes("lace"),
  },
];

export function listInjectedWallets(): InitialAPI[] {
  if (typeof window === "undefined" || !window.midnight) return [];
  return Object.values(window.midnight).filter(
    (w): w is InitialAPI => !!w && typeof w === "object" && "connect" in w && "apiVersion" in w,
  );
}

/**
 * Looks up `preferredKey` directly, falling back to `matchName` (if the
 * descriptor has one) only when the direct key lookup misses — both discovery
 * paths are documented, per the community wallet integration guide.
 */
export function discoverPreferredWallet(descriptor: KnownWalletDescriptor): InitialAPI | undefined {
  if (typeof window === "undefined" || !window.midnight) return undefined;
  const byKey = window.midnight[descriptor.key];
  if (byKey) return byKey;
  if (descriptor.matchName) {
    return listInjectedWallets().find((w) => descriptor.matchName!(w.name ?? ""));
  }
  return undefined;
}

/**
 * Picks the wallet to use when the caller has no explicit preference: 1AM
 * Wallet if installed, else Lace if installed, else whichever other
 * connector-compatible wallet is injected under `window.midnight` (first one
 * found). Used only for the legacy "no picker" path (silent auto-reconnect
 * fallback) — the picker UI itself never auto-selects a wallet.
 */
export function discoverDefaultWallet(): InitialAPI | undefined {
  for (const known of KNOWN_WALLETS) {
    const api = discoverPreferredWallet(known);
    if (api) return api;
  }
  return listInjectedWallets()[0];
}

/**
 * Builds the full wallet picker list: every `KNOWN_WALLETS` entry (installed
 * or not, so the user can discover and install it), followed by any other
 * connector-compatible wallet actually detected under `window.midnight` that
 * isn't already one of the known entries. Name/icon for installed wallets
 * come live from the wallet's own `InitialAPI` — never hardcoded.
 */
export function getWalletPickerList(): PickerWallet[] {
  const injected = listInjectedWallets();
  const claimed = new Set<InitialAPI>();

  const known: PickerWallet[] = KNOWN_WALLETS.map((descriptor) => {
    const api = discoverPreferredWallet(descriptor);
    if (api) claimed.add(api);
    return {
      id: descriptor.key,
      name: api?.name || descriptor.name,
      icon: api?.icon ?? null,
      installed: !!api,
      recommended: !!descriptor.recommended,
      downloadUrl: descriptor.downloadUrl,
      api: api ?? null,
    };
  });

  const extra: PickerWallet[] = injected
    .filter((api) => !claimed.has(api))
    .map((api) => ({
      id: api.rdns || api.name || crypto.randomUUID(),
      name: api.name || "Unknown Wallet",
      icon: api.icon ?? null,
      installed: true,
      recommended: false,
      downloadUrl: null,
      api,
    }));

  return [...known, ...extra];
}

/**
 * Polls `window.midnight` for a wallet extension to appear. Extensions
 * inject slightly after DOMContentLoaded, so this is only used to decide
 * when to *enable* a Connect button / attempt a silent auto-reconnect — the
 * actual `connect()` call must still happen synchronously inside a user
 * gesture (see `connectWallet` in walletConnector.ts), never at the end of
 * this poll.
 *
 * Returns a `cancel()` alongside the promise so a caller that no longer
 * cares about the result (e.g. an unmounting component) can stop the
 * underlying interval immediately instead of letting it run to `timeoutMs`.
 */
export function waitForWallet(
  timeoutMs = 3000,
  intervalMs = 100,
  pick: () => InitialAPI | undefined = discoverDefaultWallet,
): { promise: Promise<InitialAPI | null>; cancel: () => void } {
  let timer: ReturnType<typeof setInterval> | null = null;
  const cancel = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
  const promise = new Promise<InitialAPI | null>((resolve) => {
    const existing = pick();
    if (existing) {
      resolve(existing);
      return;
    }
    const start = Date.now();
    timer = setInterval(() => {
      const found = pick();
      if (found) {
        cancel();
        resolve(found);
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        cancel();
        resolve(null);
      }
    }, intervalMs);
  });
  return { promise, cancel };
}
