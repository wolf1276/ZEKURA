"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ConnectedAPI } from "@midnight-ntwrk/dapp-connector-api";
import {
  connectWallet,
  findLaceWallet,
  toWalletError,
  waitForWallet,
} from "@/services/midnight/walletConnector";
import { WalletError, type ConnectedWalletInfo, type WalletStatus } from "@/types/wallet";

export const EXPECTED_NETWORK_ID = process.env.NEXT_PUBLIC_NETWORK_ID?.trim() || "preview";

const RECONNECT_STORAGE_KEY = "zekura:wallet-was-connected";
const POLL_INTERVAL_MS = 5000;
const DISCOVERY_TIMEOUT_MS = 3000;

interface WalletContextValue {
  status: WalletStatus;
  wallet: ConnectedWalletInfo | null;
  errorMessage: string | null;
  expectedNetworkId: string;
  connect: () => void;
  disconnect: () => void;
  getConnectedApi: () => ConnectedAPI | null;
}

const WalletContext = createContext<WalletContextValue | null>(null);

async function loadWalletInfo(
  api: ConnectedAPI,
  walletName: string,
): Promise<ConnectedWalletInfo> {
  const [configuration, connectionStatus, shieldedAddresses, unshieldedAddress, unshieldedBalances, dustBalance] =
    await Promise.all([
      api.getConfiguration(),
      api.getConnectionStatus(),
      api.getShieldedAddresses(),
      api.getUnshieldedAddress(),
      api.getUnshieldedBalances(),
      api.getDustBalance(),
    ]);
  const networkId =
    connectionStatus.status === "connected" ? connectionStatus.networkId : configuration.networkId;
  return {
    walletName,
    unshieldedAddress: unshieldedAddress.unshieldedAddress,
    shieldedAddress: shieldedAddresses.shieldedAddress,
    shieldedCoinPublicKey: shieldedAddresses.shieldedCoinPublicKey,
    shieldedEncryptionPublicKey: shieldedAddresses.shieldedEncryptionPublicKey,
    networkId,
    unshieldedBalances,
    dustBalance,
    configuration,
  };
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<WalletStatus>("idle");
  const [wallet, setWallet] = useState<ConnectedWalletInfo | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const connectedApiRef = useRef<ConnectedAPI | null>(null);
  const walletNameRef = useRef<string>("Wallet");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const handleDisconnected = useCallback(() => {
    stopPolling();
    connectedApiRef.current = null;
    setWallet(null);
    setStatus("disconnected");
    window.localStorage.removeItem(RECONNECT_STORAGE_KEY);
  }, [stopPolling]);

  // The v4 connector has no push events for account/network changes or
  // disconnects (confirmed via the Midnight docs MCP) — getConnectionStatus()
  // polling is the documented mechanism for detecting all three.
  const startPolling = useCallback(() => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      const api = connectedApiRef.current;
      if (!api) return;
      try {
        const connectionStatus = await api.getConnectionStatus();
        if (connectionStatus.status === "disconnected") {
          handleDisconnected();
          return;
        }
        const info = await loadWalletInfo(api, walletNameRef.current);
        setWallet(info);
        setStatus(info.networkId === EXPECTED_NETWORK_ID ? "connected" : "wrong-network");
      } catch (err) {
        if (toWalletError(err).code === "disconnected") handleDisconnected();
      }
    }, POLL_INTERVAL_MS);
  }, [handleDisconnected, stopPolling]);

  const connect = useCallback(() => {
    // Must stay synchronous up to wallet.connect() — no await before it, or
    // Lace's authorization pop-up gets silently blocked.
    const initialApi = findLaceWallet();
    if (!initialApi) {
      setStatus("unavailable");
      setErrorMessage("Lace wallet not detected. Install the Lace Midnight extension and refresh.");
      return;
    }
    setStatus("connecting");
    setErrorMessage(null);
    walletNameRef.current = initialApi.name || "Lace";

    connectWallet(initialApi, EXPECTED_NETWORK_ID)
      .then(async (api) => {
        connectedApiRef.current = api;
        const info = await loadWalletInfo(api, walletNameRef.current);
        setWallet(info);
        setStatus(info.networkId === EXPECTED_NETWORK_ID ? "connected" : "wrong-network");
        window.localStorage.setItem(RECONNECT_STORAGE_KEY, "1");
        startPolling();
      })
      .catch((err) => {
        const walletError = toWalletError(err);
        setStatus("error");
        setErrorMessage(walletError.message);
      });
  }, [startPolling]);

  const disconnect = useCallback(() => {
    handleDisconnected();
    setStatus("idle");
  }, [handleDisconnected]);

  const getConnectedApi = useCallback(() => connectedApiRef.current, []);

  // Auto-reconnect on load if this browser previously connected. There is
  // no user gesture available here, so if the wallet blocks the pop-up this
  // silently falls back to "idle" and the user connects manually — it never
  // surfaces this as an error.
  useEffect(() => {
    let cancelled = false;
    const wasConnected = window.localStorage.getItem(RECONNECT_STORAGE_KEY) === "1";
    if (!wasConnected) return;

    waitForWallet(DISCOVERY_TIMEOUT_MS).then((initialApi) => {
      if (cancelled || !initialApi) return;
      walletNameRef.current = initialApi.name || "Lace";
      setStatus("connecting");
      connectWallet(initialApi, EXPECTED_NETWORK_ID)
        .then(async (api) => {
          if (cancelled) return;
          connectedApiRef.current = api;
          const info = await loadWalletInfo(api, walletNameRef.current);
          if (cancelled) return;
          setWallet(info);
          setStatus(info.networkId === EXPECTED_NETWORK_ID ? "connected" : "wrong-network");
          startPolling();
        })
        .catch(() => {
          if (!cancelled) setStatus("idle");
        });
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount only
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const value = useMemo<WalletContextValue>(
    () => ({
      status,
      wallet,
      errorMessage,
      expectedNetworkId: EXPECTED_NETWORK_ID,
      connect,
      disconnect,
      getConnectedApi,
    }),
    [status, wallet, errorMessage, connect, disconnect, getConnectedApi],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWalletContext(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWalletContext must be used within a WalletProvider");
  return ctx;
}

export { WalletError };
