"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { setNetworkId as setSdkNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import {
  DEFAULT_NETWORK_ID,
  NETWORK_CONFIGS,
  getNetworkConfig,
  isNetworkId,
  type NetworkId,
} from "./networkConfig";
import { NetworkContext, type NetworkContextValue } from "./networkContext";
import { isTxPending, onWalletNetworkChanged, requestWalletNetworkSwitch, NoWalletConnectedError } from "./networkBridge";

const STORAGE_KEY = "zekura:network-id";

// Midnight.js's global network id (bech32m address prefixes, tx encoding —
// e.g. midnight-js-contracts' parseCoinPublicKeyToHex reads this on every
// call) MUST be set before any SDK call, and there is no default — calling
// getNetworkId() before setNetworkId() throws. Set it at module scope, i.e.
// as soon as this file is imported (well before any component mounts or any
// user action can trigger an SDK call), instead of only inside an effect.
setSdkNetworkId(getNetworkConfig(DEFAULT_NETWORK_ID).walletNetworkId);

function readPersistedNetworkId(): NetworkId | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return isNetworkId(raw) ? raw : null;
  } catch {
    // Storage inaccessible (private browsing, disabled storage, etc.) — fall
    // back to the default network silently, same as any other localStorage
    // read in this app (see wallet/WalletProvider.tsx).
    return null;
  }
}

function persistNetworkId(id: NetworkId): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Non-fatal — the network still switches for this session, it just
    // won't survive a refresh.
  }
}

export function NetworkProvider({ children }: { children: React.ReactNode }) {
  // Always start at the default on both server and first client render —
  // reading localStorage here would desync the SSR-rendered HTML from the
  // client's first render (a real hydration mismatch hit during this
  // project's own wallet-detection code; see WalletProvider.tsx). The real
  // persisted value is applied a moment later, once, in the effect below.
  const [networkId, setNetworkIdState] = useState<NetworkId>(DEFAULT_NETWORK_ID);
  const [isReady, setIsReady] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);

  // Bumped on every requestNetworkSwitch call. Lets an in-flight switch
  // attempt notice it has been superseded — by a newer switch request, or by
  // a spontaneous wallet-side change arriving first — and skip touching
  // state, which is what keeps overlapping switches from racing each other.
  const generationRef = useRef(0);

  useEffect(() => {
    const persisted = readPersistedNetworkId();
    // localStorage doesn't exist during SSR, so this can only ever run
    // client-side, post-mount — there is no render-time equivalent that
    // would keep the server-rendered HTML and the client's first render
    // identical (see the comment above the `networkId` useState call).
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time hydration read from an external system (localStorage), not derivable during render without desyncing SSR output
    if (persisted && persisted !== networkId) setNetworkIdState(persisted);
    setIsReady(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount only, to apply the persisted value exactly one time
  }, []);

  // The ONE place the SDK's global network id is ever set, keyed strictly on
  // `networkId` — the confirmed value (wallet-confirmed when connected,
  // persisted preference otherwise) — never on an aspirational target. This
  // is what "Call setNetworkId() correctly" means here: the SDK must always
  // agree with whatever network the wallet actually reports, never with
  // whatever the app merely asked for.
  useEffect(() => {
    setSdkNetworkId(getNetworkConfig(networkId).walletNetworkId);
  }, [networkId]);

  // The wallet is the single source of truth once connected. Whether the
  // change came from this app's own requestNetworkSwitch below or the user
  // switching networks directly inside their wallet's own UI, WalletProvider
  // reports it here the same way — this one listener is what fixes "changing
  // the wallet network doesn't update Zekura".
  useEffect(() => {
    return onWalletNetworkChanged((walletNetworkId) => {
      generationRef.current += 1; // supersede any switch this app had in flight
      setSwitching(false);
      if (!isNetworkId(walletNetworkId)) {
        // Wallet is on a network Zekura has no config for (e.g. 'mainnet' or
        // 'undeployed' today) — nothing in NETWORK_CONFIGS to adopt. Leave
        // the app's own networkId alone; WalletProvider surfaces this as an
        // "unsupported network" wallet status so the UI can tell the user to
        // switch their wallet instead of silently ignoring it.
        setSwitchError(`Your wallet is on a network Zekura doesn't support ("${walletNetworkId}").`);
        return;
      }
      setSwitchError(null);
      setNetworkIdState(walletNetworkId);
      persistNetworkId(walletNetworkId);
    });
  }, []);

  const requestNetworkSwitch = useCallback(
    (id: NetworkId) => {
      if (id === networkId) return;
      if (isTxPending()) {
        setSwitchError("Wait for your pending order to finish before switching networks.");
        return;
      }

      const myGeneration = ++generationRef.current;
      setSwitching(true);
      setSwitchError(null);

      requestWalletNetworkSwitch(id)
        .then(() => {
          // Success is confirmed via onWalletNetworkChanged above (which
          // also clears `switching`) — nothing else to do here. Guard against
          // a superseded attempt still flipping the spinner off late.
          if (generationRef.current !== myGeneration) return;
          setSwitching(false);
        })
        .catch((err) => {
          if (generationRef.current !== myGeneration) return;
          setSwitching(false);
          if (err instanceof NoWalletConnectedError) {
            // Nothing to confirm — just move the app's own preference so the
            // next connect attempt targets this network.
            setNetworkIdState(id);
            persistNetworkId(id);
            return;
          }
          setSwitchError(err instanceof Error ? err.message : "Failed to switch network.");
        });
    },
    [networkId],
  );

  const value = useMemo<NetworkContextValue>(
    () => ({
      networkId,
      network: NETWORK_CONFIGS[networkId],
      isReady,
      switching,
      switchError,
      requestNetworkSwitch,
    }),
    [networkId, isReady, switching, switchError, requestNetworkSwitch],
  );

  return <NetworkContext.Provider value={value}>{children}</NetworkContext.Provider>;
}
