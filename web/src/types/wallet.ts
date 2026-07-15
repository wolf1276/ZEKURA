/**
 * Types for the Midnight DApp Connector integration
 * (@midnight-ntwrk/dapp-connector-api v4.0.1) — used by 1AM Wallet, Lace, and
 * any other compatible wallet. Kept separate from the connector's own types
 * so the rest of the app depends on a small, UI-shaped surface instead of the
 * full connector API.
 */

export type WalletStatus =
  | "unavailable"
  | "idle"
  | "connecting"
  | "connected"
  | "wrong-network"
  | "disconnected"
  | "error";

export interface WalletConfiguration {
  indexerUri: string;
  indexerWsUri: string;
  substrateNodeUri: string;
  proverServerUri?: string;
  networkId: string;
}

export interface ConnectedWalletInfo {
  walletName: string;
  unshieldedAddress: string;
  shieldedAddress: string;
  shieldedCoinPublicKey: string;
  shieldedEncryptionPublicKey: string;
  networkId: string;
  unshieldedBalances: Record<string, bigint>;
  dustBalance: { balance: bigint; cap: bigint };
  configuration: WalletConfiguration;
}

export type WalletErrorCode =
  | "wallet-missing"
  | "rejected"
  | "permission-rejected"
  | "wrong-network"
  | "disconnected"
  | "invalid-request"
  | "internal-error"
  | "unknown";

export class WalletError extends Error {
  readonly code: WalletErrorCode;

  constructor(code: WalletErrorCode, message: string) {
    super(message);
    this.name = "WalletError";
    this.code = code;
  }
}
