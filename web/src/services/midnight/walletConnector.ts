/**
 * Discovery and connection helpers for the Midnight DApp Connector API
 * (@midnight-ntwrk/dapp-connector-api v4.0.1). Every method/field used here
 * is documented in that package / docs.midnight.network/api-reference/dapp-connector —
 * nothing invented.
 */
import "@midnight-ntwrk/dapp-connector-api";
import type { APIError, ConnectedAPI, InitialAPI } from "@midnight-ntwrk/dapp-connector-api";
import { WalletError, type WalletErrorCode } from "@/types/wallet";

/** Lace's fixed injection key (confirmed in the Midnight docs and SDKs). */
const LACE_KEY = "mnLace";

export function listInjectedWallets(): InitialAPI[] {
  if (typeof window === "undefined" || !window.midnight) return [];
  return Object.values(window.midnight).filter(
    (w): w is InitialAPI => !!w && typeof w === "object" && "connect" in w && "apiVersion" in w,
  );
}

/**
 * Prefers Lace's fixed key, then falls back to scanning `window.midnight`
 * (wallets other than Lace/1AM inject under a generated key per the v4
 * spec) — both discovery paths are documented, per
 * docs.midnight.network/sdks/community/wallets/community-wallets-integration.
 */
export function findLaceWallet(): InitialAPI | undefined {
  if (typeof window === "undefined" || !window.midnight) return undefined;
  const byKey = window.midnight[LACE_KEY];
  if (byKey) return byKey;
  return listInjectedWallets().find((w) => w.name?.toLowerCase().includes("lace"));
}

/**
 * Polls `window.midnight` for a wallet extension to appear. Extensions
 * inject slightly after DOMContentLoaded, so this is only used to decide
 * when to *enable* a Connect button / attempt a silent auto-reconnect — the
 * actual `connect()` call must still happen synchronously inside a user
 * gesture (see `connectWallet` below), never at the end of this poll.
 */
export function waitForWallet(timeoutMs = 3000, intervalMs = 100): Promise<InitialAPI | null> {
  return new Promise((resolve) => {
    const existing = findLaceWallet();
    if (existing) {
      resolve(existing);
      return;
    }
    const start = Date.now();
    const timer = setInterval(() => {
      const found = findLaceWallet();
      if (found) {
        clearInterval(timer);
        resolve(found);
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        clearInterval(timer);
        resolve(null);
      }
    }, intervalMs);
  });
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
 * Lace's authorization pop-up is silently blocked by the browser otherwise
 * (documented pop-up-blocking behavior).
 */
export function connectWallet(wallet: InitialAPI, networkId: string): Promise<ConnectedAPI> {
  return wallet.connect(networkId);
}
