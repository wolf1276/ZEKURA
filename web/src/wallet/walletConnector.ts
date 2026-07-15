/**
 * Connection and error-normalization helpers for the Midnight DApp Connector
 * API (@midnight-ntwrk/dapp-connector-api v4.0.1). Every method/field used
 * here is documented in that package / docs.midnight.network/api-reference/dapp-connector —
 * nothing invented. Wallet discovery lives in walletRegistry.ts; this file
 * only knows how to connect to an already-chosen wallet and how to interpret
 * failures.
 */
import "@midnight-ntwrk/dapp-connector-api";
import type { APIError, ConnectedAPI, InitialAPI } from "@midnight-ntwrk/dapp-connector-api";
import { WalletError, type WalletErrorCode } from "./walletTypes";

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
 * user gesture (e.g. a wallet card's onClick) with nothing awaited before it
 * — the wallet's authorization pop-up is silently blocked by the browser
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
