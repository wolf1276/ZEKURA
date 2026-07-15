"use client";

import { createContext, useContext } from "react";
import type { NetworkConfig, NetworkId } from "./networkConfig";

export interface NetworkContextValue {
  /**
   * The app's single current network. Mirrors the connected wallet's
   * confirmed network whenever a wallet is connected; falls back to the
   * user's last-picked (persisted) preference when no wallet is connected.
   * There is exactly one writer for this value — see the wallet-network
   * listener in NetworkProvider.tsx.
   */
  networkId: NetworkId;
  network: NetworkConfig;
  /**
   * False until the persisted preference (if any) has been read from
   * localStorage. Consumers that need to act on the *correct* network
   * exactly once on mount (e.g. the wallet's silent auto-reconnect) must
   * wait for this to flip true instead of trusting the first render's
   * `networkId` — that first render is always `DEFAULT_NETWORK_ID`, matched
   * to the server-rendered HTML on purpose (see NetworkProvider.tsx).
   */
  isReady: boolean;
  /** True while an app-requested network switch is awaiting wallet confirmation. Trading should be disabled while this is true. */
  switching: boolean;
  /** Set if the last `requestNetworkSwitch` failed; cleared on the next request. */
  switchError: string | null;
  /**
   * Requests a switch to `id`. If a wallet is connected, this asks the
   * *wallet* to switch (via the bridge in networkBridge.ts) and only updates
   * `networkId` once the wallet confirms — it never flips the app's network
   * optimistically. If no wallet is connected, there is nothing to confirm,
   * so the preference updates immediately.
   */
  requestNetworkSwitch: (id: NetworkId) => void;
}

export const NetworkContext = createContext<NetworkContextValue | null>(null);

export function useNetworkContext(): NetworkContextValue {
  const ctx = useContext(NetworkContext);
  if (!ctx) throw new Error("useNetworkContext must be used within a NetworkProvider");
  return ctx;
}
