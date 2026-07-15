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
  discoverDefaultWallet,
  toWalletError,
  waitForWallet,
  withTimeout,
} from "@/services/midnight/walletConnector";
import { WalletError, type ConnectedWalletInfo, type WalletStatus } from "@/types/wallet";

export const EXPECTED_NETWORK_ID = process.env.NEXT_PUBLIC_NETWORK_ID?.trim() || "preprod";

const RECONNECT_STORAGE_KEY = "zekura:wallet-was-connected";
const POLL_INTERVAL_MS = 5000;
const DISCOVERY_TIMEOUT_MS = 3000;
// Safety net against a hung wallet extension whose connect() promise never
// settles — generous on purpose, since a real approval pop-up can sit
// unanswered for a while without anything being wrong.
const CONNECT_TIMEOUT_MS = 120_000;
// getConnectionStatus() is documented as the way to check connection
// validity, but any single call can also fail transiently (e.g. the
// extension is momentarily busy). Only treat the wallet as gone after
// several consecutive failures, so a blip doesn't display a stale
// "connected" wallet forever nor drop a healthy session on one hiccup.
const MAX_CONSECUTIVE_POLL_FAILURES = 3;

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
  const pollFailureCountRef = useRef(0);
  // Bumped on every new connect attempt AND on disconnect/unmount. Any
  // in-flight async chain compares its captured value against the current
  // one before touching state/refs — if they differ, a newer attempt (or a
  // disconnect, or unmount) has superseded it, so it's a no-op. This is what
  // prevents two overlapping connect flows (e.g. a double-clicked Connect
  // button, or manual connect racing the auto-reconnect effect) from both
  // writing connectedApiRef/starting polling, and stops a stale attempt from
  // resurrecting a session the user already disconnected.
  const generationRef = useRef(0);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const handleDisconnected = useCallback(() => {
    generationRef.current += 1;
    stopPolling();
    pollFailureCountRef.current = 0;
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
    pollFailureCountRef.current = 0;
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
        pollFailureCountRef.current = 0;
        setWallet(info);
        setStatus(info.networkId === EXPECTED_NETWORK_ID ? "connected" : "wrong-network");
      } catch (err) {
        if (toWalletError(err).code === "disconnected") {
          handleDisconnected();
          return;
        }
        // Transient failure (extension busy, momentary indexer hiccup,
        // etc). Don't tear down the session on the first one, but don't
        // keep showing a possibly-stale "connected" wallet forever either.
        pollFailureCountRef.current += 1;
        if (pollFailureCountRef.current >= MAX_CONSECUTIVE_POLL_FAILURES) {
          handleDisconnected();
        }
      }
    }, POLL_INTERVAL_MS);
  }, [handleDisconnected, stopPolling]);

  const connect = useCallback(() => {
    // Idempotent: ignore a second call while one is already in flight (e.g.
    // a double-clicked Connect button), which would otherwise open two
    // wallet approval pop-ups and race two connection attempts.
    if (status === "connecting") return;

    // Must stay synchronous up to wallet.connect() — no await before it, or
    // the wallet's authorization pop-up gets silently blocked. Prefers 1AM
    // Wallet, falls back to Lace, then any other connector-compatible wallet.
    const initialApi = discoverDefaultWallet();
    if (!initialApi) {
      console.warn("[wallet] connect(): no wallet found under window.midnight");
      setStatus("unavailable");
      setErrorMessage(
        "No Midnight wallet detected. Install 1AM Wallet (or another Midnight-compatible wallet, e.g. Lace) and refresh.",
      );
      return;
    }
    const myGeneration = ++generationRef.current;
    setStatus("connecting");
    setErrorMessage(null);
    walletNameRef.current = initialApi.name || "Wallet";

    withTimeout(
      connectWallet(initialApi, EXPECTED_NETWORK_ID),
      CONNECT_TIMEOUT_MS,
      () => new WalletError("internal-error", "Wallet did not respond in time. Check the extension and try again."),
    )
      .then(async (api) => {
        if (generationRef.current !== myGeneration) return;
        const info = await loadWalletInfo(api, walletNameRef.current);
        if (generationRef.current !== myGeneration) return;
        connectedApiRef.current = api;
        setWallet(info);
        setStatus(info.networkId === EXPECTED_NETWORK_ID ? "connected" : "wrong-network");
        window.localStorage.setItem(RECONNECT_STORAGE_KEY, "1");
        startPolling();
      })
      .catch((err) => {
        if (generationRef.current !== myGeneration) return;
        const walletError = toWalletError(err);
        console.error("[wallet] connect() failed:", walletError.code, walletError.message, err);
        setStatus("error");
        setErrorMessage(walletError.message);
      });
  }, [status, startPolling]);

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
    const wasConnected = window.localStorage.getItem(RECONNECT_STORAGE_KEY) === "1";
    if (!wasConnected) return;

    const myGeneration = ++generationRef.current;
    const { promise, cancel } = waitForWallet(DISCOVERY_TIMEOUT_MS);

    promise
      .then((initialApi) => {
        if (generationRef.current !== myGeneration || !initialApi) return;
        walletNameRef.current = initialApi.name || "Wallet";
        setStatus("connecting");
        return withTimeout(
          connectWallet(initialApi, EXPECTED_NETWORK_ID),
          CONNECT_TIMEOUT_MS,
          () => new WalletError("internal-error", "Wallet did not respond in time."),
        )
          .then(async (api) => {
            if (generationRef.current !== myGeneration) return;
            const info = await loadWalletInfo(api, walletNameRef.current);
            if (generationRef.current !== myGeneration) return;
            connectedApiRef.current = api;
            setWallet(info);
            setStatus(info.networkId === EXPECTED_NETWORK_ID ? "connected" : "wrong-network");
            startPolling();
          });
      })
      .catch((err) => {
        // Silent by design (no user gesture to show an error against), but
        // still log it — silently falling back to "idle" previously left no
        // trace at all of why auto-reconnect didn't happen.
        console.warn("[wallet] silent auto-reconnect failed, falling back to idle:", toWalletError(err).message);
        if (generationRef.current === myGeneration) setStatus("idle");
      });

    return () => {
      generationRef.current += 1;
      cancel();
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
