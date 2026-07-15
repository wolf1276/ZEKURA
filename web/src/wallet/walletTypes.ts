/**
 * Types for the Midnight DApp Connector integration
 * (@midnight-ntwrk/dapp-connector-api v4.0.1) — used by 1AM Wallet, Lace, and
 * any other compatible wallet. Kept separate from the connector's own types
 * so the rest of the app depends on a small, UI-shaped surface instead of the
 * full connector API.
 */
import type { InitialAPI } from "@midnight-ntwrk/dapp-connector-api";
import { getNetworkConfig, isNetworkId } from "@/network/networkConfig";

export type WalletStatus =
  | "unavailable"
  | "idle"
  | "connecting"
  | "connected"
  /** Wallet is connected but reports a network id Zekura has no NetworkConfig for (e.g. 'mainnet', 'undeployed') — see network/networkConfig.ts for the supported set. */
  | "unsupported-network"
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
  | "unsupported-network"
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

/**
 * A wallet with a fixed, documented injection key (per
 * docs.midnight.network/sdks/community/wallets/community-wallets-integration)
 * that the picker should show and brand even when it isn't installed —
 * so the user can discover and install it. `matchName` is an extra
 * fallback lookup for wallets (like Lace) whose display name is a
 * reliable substring when the fixed key lookup misses.
 */
export interface KnownWalletDescriptor {
  key: string;
  name: string;
  downloadUrl: string;
  recommended?: boolean;
  matchName?: (name: string) => boolean;
}

/** One row in the wallet picker modal — either a known or auto-detected wallet. */
export interface PickerWallet {
  id: string;
  name: string;
  icon: string | null;
  installed: boolean;
  recommended: boolean;
  downloadUrl: string | null;
  api: InitialAPI | null;
}

/**
 * Human-readable label for any network id a wallet might report. Ids Zekura
 * has a NetworkConfig for (see network/networkConfig.ts — the single source
 * of truth for network identity) use its `label`; anything else (e.g.
 * 'mainnet', 'undeployed' — real Midnight network ids Zekura doesn't
 * configure yet) is humanized generically rather than duplicating a second
 * hardcoded label table here.
 */
export function networkLabel(networkId: string): string {
  if (isNetworkId(networkId)) return getNetworkConfig(networkId).label;
  return networkId.length === 0 ? networkId : networkId[0].toUpperCase() + networkId.slice(1);
}
