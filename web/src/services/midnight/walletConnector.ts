/**
 * Discovery and connection helpers for the Midnight DApp Connector API
 * (@midnight-ntwrk/dapp-connector-api v4.0.1). Every method/field used here
 * is documented in that package / docs.midnight.network/api-reference/dapp-connector —
 * nothing invented.
 *
 * This module is the ONLY place that knows about specific wallets (1AM,
 * Lace, or anything else injected under `window.midnight`). Everything above
 * it (WalletProvider, exchangeContract.ts, use-submit-order.ts) only ever
 * touches the generic `ConnectedAPI` type, so changing wallet priority or
 * adding a wallet-picker UI (backed by `listInjectedWallets()`) is a change
 * confined to this file — no business-logic file needs to change.
 *
 * Default-wallet priority (`discoverDefaultWallet`): 1AM Wallet first (the
 * preferred dev/test wallet for this app), then Lace, then whatever other
 * connector-compatible wallet is installed — so the app never fails to find
 * a wallet just because it isn't one of the two special-cased keys.
 */
import "@midnight-ntwrk/dapp-connector-api";
import type { APIError, ConnectedAPI, InitialAPI } from "@midnight-ntwrk/dapp-connector-api";
import { WalletError, type WalletErrorCode } from "@/types/wallet";

/**
 * Fixed injection keys for wallets that use one (confirmed in the Midnight
 * docs' community wallet integration guide: `window.midnight.mnLace`,
 * `window.midnight['1am']`). Other connector-compatible wallets inject under
 * a generated/rdns key instead — discover those via `listInjectedWallets()`.
 */
export const KNOWN_WALLET_KEYS = {
  lace: "mnLace",
  oneAM: "1am",
} as const;

export function listInjectedWallets(): InitialAPI[] {
  if (typeof window === "undefined" || !window.midnight) return [];
  return Object.values(window.midnight).filter(
    (w): w is InitialAPI => !!w && typeof w === "object" && "connect" in w && "apiVersion" in w,
  );
}

/**
 * Looks up `preferredKey` directly, falling back to a name-based scan only
 * for Lace (whose display name is a reliable "lace" substring per the docs'
 * own example code) — both discovery paths are documented, per
 * docs.midnight.network/sdks/community/wallets/community-wallets-integration.
 * For any other key (e.g. `KNOWN_WALLET_KEYS.oneAM`), a miss returns
 * `undefined` rather than guessing by name, since name substrings are not a
 * reliable identifier for wallets we don't special-case.
 */
export function discoverPreferredWallet(
  preferredKey: string = KNOWN_WALLET_KEYS.oneAM,
): InitialAPI | undefined {
  if (typeof window === "undefined" || !window.midnight) return undefined;
  const byKey = window.midnight[preferredKey];
  if (byKey) return byKey;
  if (preferredKey === KNOWN_WALLET_KEYS.lace) {
    return listInjectedWallets().find((w) => w.name?.toLowerCase().includes("lace"));
  }
  return undefined;
}

/**
 * Picks the wallet to use when the caller has no explicit preference: 1AM
 * Wallet if installed, else Lace if installed, else whichever other
 * connector-compatible wallet is injected under `window.midnight` (first one
 * found). This is what `WalletProvider.connect()` and auto-reconnect use —
 * neither one hardcodes a specific wallet.
 */
export function discoverDefaultWallet(): InitialAPI | undefined {
  return (
    discoverPreferredWallet(KNOWN_WALLET_KEYS.oneAM) ??
    discoverPreferredWallet(KNOWN_WALLET_KEYS.lace) ??
    listInjectedWallets()[0]
  );
}

/**
 * Polls `window.midnight` for a wallet extension to appear. Extensions
 * inject slightly after DOMContentLoaded, so this is only used to decide
 * when to *enable* a Connect button / attempt a silent auto-reconnect — the
 * actual `connect()` call must still happen synchronously inside a user
 * gesture (see `connectWallet` below), never at the end of this poll.
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

export function isDAppConnectorError(error: unknown): error is APIError {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { type?: unknown }).type === "DAppConnectorAPIError"
  );
}

const ERROR_CODE_MAP: Record<string, WalletErrorCode> = {
  Rejected: "rejected",
  PermissionRejected: "permission-rejected",
  InvalidRequest: "invalid-request",
  InternalError: "internal-error",
  Disconnected: "disconnected",
};

/** Normalizes any connector failure into a `WalletError` with a user-facing message. */
export function toWalletError(error: unknown): WalletError {
  if (error instanceof WalletError) return error;
  if (isDAppConnectorError(error)) {
    const code = ERROR_CODE_MAP[error.code] ?? "unknown";
    switch (error.code) {
      case "Rejected":
        return new WalletError(code, "Order cancelled — you declined the request in your wallet.");
      case "PermissionRejected":
        return new WalletError(
          code,
          "Zekura is blocked in your wallet's permissions — unblock it in your wallet settings and try again.",
        );
      case "Disconnected":
        return new WalletError(code, "Wallet connection was lost. Reconnect and try again.");
      case "InvalidRequest":
        return new WalletError(code, `Wallet rejected the request: ${error.reason}`);
      default:
        return new WalletError(code, error.reason || error.message || "Wallet error");
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return new WalletError("unknown", message);
}

/**
 * Connects to `wallet` on `networkId`. MUST be called synchronously inside a
 * user gesture (e.g. a button's onClick) with nothing awaited before it —
 * the wallet's authorization pop-up is silently blocked by the browser
 * otherwise (documented pop-up-blocking behavior, applies to any extension).
 *
 * `wallet.connect` is typed as always returning a `Promise`, but a
 * misbehaving extension can still throw synchronously instead of rejecting.
 * The try/catch below converts that into a rejected promise *without*
 * introducing a microtask before the call — `wallet.connect(networkId)` is
 * still invoked synchronously — so callers get one consistent
 * promise-rejection path instead of an uncaught exception / unhandled
 * rejection depending on how the wallet happens to fail.
 */
export function connectWallet(wallet: InitialAPI, networkId: string): Promise<ConnectedAPI> {
  try {
    return wallet.connect(networkId);
  } catch (err) {
    return Promise.reject(err);
  }
}

/**
 * Races `promise` against a timer so a hung wallet extension (never
 * resolving or rejecting `connect()`) can't leave the UI stuck in
 * "connecting" forever. `ms` should stay generous — the user may be reading
 * a real approval dialog — this is a safety net for a broken connector, not
 * a UX cutoff for a slow-but-attentive user.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
