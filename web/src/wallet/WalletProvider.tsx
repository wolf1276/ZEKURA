"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ConnectedAPI } from "@midnight-ntwrk/dapp-connector-api";
import {
  connectWallet,
  toWalletError,
  withTimeout,
} from "./walletConnector";
import { getWalletPickerList, waitForWallet } from "./walletRegistry";
import { WalletContext, type WalletContextValue } from "./walletContext";
import { WalletError, type ConnectedWalletInfo, type PickerWallet, type WalletStatus } from "./walletTypes";
import { useNetworkContext } from "@/network/networkContext";
import { isNetworkId, type NetworkId } from "@/network/networkConfig";
import { NoWalletConnectedError, emitWalletNetworkChanged, setWalletNetworkBridge } from "@/network/networkBridge";

const RECONNECT_STORAGE_KEY = "zekura:wallet-was-connected";
const LAST_WALLET_ID_KEY = "zekura:last-wallet-id";
const POLL_INTERVAL_MS = 5000;
const PICKER_REFRESH_MS = 1000;
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

/** "connected" if Zekura has a NetworkConfig for the wallet's reported network, "unsupported-network" otherwise (e.g. the wallet is on 'mainnet'/'undeployed' — real ids Zekura just doesn't configure yet, see network/networkConfig.ts). There is no more "wrong network" concept — the wallet's network is always adopted as the app's own (see networkBridge.ts), so the only way to be out of sync is a network Zekura can't represent at all. */
function statusForWallet(info: ConnectedWalletInfo): WalletStatus {
  return isNetworkId(info.networkId) ? "connected" : "unsupported-network";
}

function computeInitialStatus(list: PickerWallet[]): WalletStatus {
  return list.some((w) => w.installed) ? "idle" : "unavailable";
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const { network, isReady: networkReady } = useNetworkContext();
  // Only used as the *hint* passed to wallet.connect(networkId) — for a
  // fresh connect or the silent auto-reconnect on page load, where Zekura
  // has to propose some network before the wallet has said anything. Once a
  // wallet responds, its own reported network (read back via
  // getConnectionStatus()/getConfiguration() in loadWalletInfo) is what's
  // trusted from then on — see the emitWalletNetworkChanged calls below and
  // networkBridge.ts's header comment.
  const networkHintRef = useRef(network.walletNetworkId);
  useEffect(() => {
    networkHintRef.current = network.walletNetworkId;
  }, [network.walletNetworkId]);

  // Wallet availability (installed vs not) can only be read from
  // `window.midnight`, which doesn't exist during SSR — starting from a
  // fixed, render-independent value here (instead of calling
  // getWalletPickerList()/computeInitialStatus() inline in useState) keeps
  // the server-rendered HTML and the client's first render identical. The
  // real, browser-derived value is applied a moment later in the mount
  // effect below (this was a real hydration mismatch before this fix — the
  // triangle "unavailable" icon flashing on the server render before the
  // real "idle"/connect icon overwrote it in the client render).
  const [pickerWallets, setPickerWallets] = useState<PickerWallet[]>([]);
  const [status, setStatus] = useState<WalletStatus>("idle");
  const [wallet, setWallet] = useState<ConnectedWalletInfo | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [connectingWalletId, setConnectingWalletId] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);

  const connectedApiRef = useRef<ConnectedAPI | null>(null);
  const walletNameRef = useRef<string>("Wallet");
  // Picker id of the currently-connected (or being-connected) wallet, so a
  // network switch can look its InitialAPI back up from the registry and
  // reconnect without the user having to reopen the picker.
  const walletIdRef = useRef<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollFailureCountRef = useRef(0);
  const pickerRefreshRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pickerWalletsRef = useRef<PickerWallet[]>(pickerWallets);
  // The last network id reported to networkBridge.ts's
  // emitWalletNetworkChanged, so repeated polls of an unchanged wallet don't
  // re-emit (and re-trigger NetworkProvider's persistence write) every tick.
  const lastEmittedNetworkIdRef = useRef<string | null>(null);
  // Bumped on every new connect attempt AND on disconnect/unmount. Any
  // in-flight async chain compares its captured value against the current
  // one before touching state/refs — if they differ, a newer attempt (or a
  // disconnect, or unmount) has superseded it, so it's a no-op. This is what
  // prevents two overlapping connect flows (e.g. two quick wallet-card
  // clicks, manual connect racing the auto-reconnect effect, or a network
  // switch racing either) from both writing connectedApiRef/starting
  // polling, and stops a stale attempt from resurrecting a session the user
  // already disconnected.
  const generationRef = useRef(0);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  /** Reports `id` up to the Network Manager iff it's different from the last id reported — see networkBridge.ts. */
  const reportWalletNetworkId = useCallback((id: string) => {
    if (lastEmittedNetworkIdRef.current === id) return;
    lastEmittedNetworkIdRef.current = id;
    emitWalletNetworkChanged(id);
  }, []);

  const handleDisconnected = useCallback(() => {
    generationRef.current += 1;
    stopPolling();
    pollFailureCountRef.current = 0;
    connectedApiRef.current = null;
    walletIdRef.current = null;
    lastEmittedNetworkIdRef.current = null;
    setWallet(null);
    setStatus("disconnected");
    window.localStorage.removeItem(RECONNECT_STORAGE_KEY);
    window.localStorage.removeItem(LAST_WALLET_ID_KEY);
  }, [stopPolling]);

  // The v4 connector has no push events for account/network changes or
  // disconnects (confirmed via the Midnight docs MCP) — getConnectionStatus()
  // polling is the documented mechanism for detecting all three, including a
  // network switched from inside the wallet's own UI (reported up via
  // reportWalletNetworkId, which is what keeps Zekura in sync with a wallet
  // whose network changed outside the app).
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
        setStatus(statusForWallet(info));
        reportWalletNetworkId(info.networkId);
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
  }, [handleDisconnected, reportWalletNetworkId, stopPolling]);

  const refreshPickerWallets = useCallback(() => {
    const list = getWalletPickerList();
    pickerWalletsRef.current = list;
    setPickerWallets(list);
    return list;
  }, []);

  // Runs once on mount, client-only — this is what actually applies the
  // browser-derived wallet-availability state after the hydration-safe
  // render above.
  useEffect(() => {
    // window.midnight doesn't exist during SSR, so this can only ever run
    // client-side, post-mount — same hydration-safety reasoning as the
    // Network Manager's persisted-network read (see NetworkProvider.tsx).
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time hydration read from an external system (window.midnight), not derivable during render without desyncing SSR output
    const list = refreshPickerWallets();
    setStatus((prev) => (prev === "idle" ? computeInitialStatus(list) : prev));
  }, [refreshPickerWallets]);

  const openModal = useCallback(() => {
    setErrorMessage(null);
    refreshPickerWallets();
    setIsModalOpen(true);
  }, [refreshPickerWallets]);

  const closeModal = useCallback(() => {
    setIsModalOpen(false);
  }, []);

  // Live-detect wallets injected after the modal is already open (extensions
  // can announce themselves slightly late) — only while the modal is open,
  // so this never runs as a background cost.
  useEffect(() => {
    if (!isModalOpen) {
      if (pickerRefreshRef.current) {
        clearInterval(pickerRefreshRef.current);
        pickerRefreshRef.current = null;
      }
      return;
    }
    pickerRefreshRef.current = setInterval(refreshPickerWallets, PICKER_REFRESH_MS);
    return () => {
      if (pickerRefreshRef.current) {
        clearInterval(pickerRefreshRef.current);
        pickerRefreshRef.current = null;
      }
    };
  }, [isModalOpen, refreshPickerWallets]);

  const connectTo = useCallback(
    (id: string) => {
      // Idempotent: ignore a second call while one is already in flight.
      if (connectingWalletId) return;

      const entry =
        pickerWalletsRef.current.find((w) => w.id === id) ??
        getWalletPickerList().find((w) => w.id === id);
      if (!entry || !entry.api) return;

      // Must stay synchronous up to wallet.connect() — no await before it,
      // or the wallet's authorization pop-up gets silently blocked.
      const api = entry.api;
      const myGeneration = ++generationRef.current;
      setConnectingWalletId(id);
      setErrorMessage(null);
      setStatus("connecting");
      walletNameRef.current = api.name || entry.name;

      withTimeout(
        connectWallet(api, networkHintRef.current),
        CONNECT_TIMEOUT_MS,
        () => new WalletError("internal-error", "Wallet did not respond in time. Check the extension and try again."),
      )
        .then(async (connected) => {
          if (generationRef.current !== myGeneration) return;
          const info = await loadWalletInfo(connected, walletNameRef.current);
          if (generationRef.current !== myGeneration) return;
          connectedApiRef.current = connected;
          walletIdRef.current = id;
          setWallet(info);
          setStatus(statusForWallet(info));
          setConnectingWalletId(null);
          window.localStorage.setItem(RECONNECT_STORAGE_KEY, "1");
          window.localStorage.setItem(LAST_WALLET_ID_KEY, id);
          startPolling();
          reportWalletNetworkId(info.networkId);
          setIsModalOpen(false);
        })
        .catch((err) => {
          if (generationRef.current !== myGeneration) return;
          const walletError = toWalletError(err);
          console.error("[wallet] connectTo() failed:", walletError.code, walletError.message, err);
          setConnectingWalletId(null);
          setStatus((prev) => (prev === "connecting" ? "idle" : prev));
          setErrorMessage(
            walletError.code === "rejected" ? "Connection cancelled." : "Unable to connect wallet. Try again.",
          );
        });
    },
    [connectingWalletId, startPolling, reportWalletNetworkId],
  );

  const disconnect = useCallback(() => {
    handleDisconnected();
    setStatus("idle");
  }, [handleDisconnected]);

  const getConnectedApi = useCallback(() => connectedApiRef.current, []);

  // Auto-reconnect on load if this browser previously connected — to the
  // same wallet it was last connected to, hinting the network the Network
  // Manager has just settled on (persisted choice, or the default). Gated
  // on `networkReady` so this never fires against the SSR-matched default
  // network before NetworkProvider has had a chance to apply a persisted
  // choice from localStorage — see NetworkProvider.tsx. There is no user
  // gesture available here, so if the wallet blocks the pop-up this
  // silently falls back to "idle" and the user connects manually via the
  // picker — it never surfaces this as an error.
  useEffect(() => {
    if (!networkReady) return;
    const wasConnected = window.localStorage.getItem(RECONNECT_STORAGE_KEY) === "1";
    if (!wasConnected) return;
    const lastWalletId = window.localStorage.getItem(LAST_WALLET_ID_KEY);

    const myGeneration = ++generationRef.current;
    const { promise, cancel } = waitForWallet(DISCOVERY_TIMEOUT_MS, 100, () =>
      lastWalletId ? getWalletPickerList().find((w) => w.id === lastWalletId)?.api ?? undefined : undefined,
    );

    promise
      .then((initialApi) => {
        if (generationRef.current !== myGeneration || !initialApi) return;
        walletNameRef.current = initialApi.name || "Wallet";
        setStatus("connecting");
        return withTimeout(
          connectWallet(initialApi, networkHintRef.current),
          CONNECT_TIMEOUT_MS,
          () => new WalletError("internal-error", "Wallet did not respond in time."),
        )
          .then(async (api) => {
            if (generationRef.current !== myGeneration) return;
            const info = await loadWalletInfo(api, walletNameRef.current);
            if (generationRef.current !== myGeneration) return;
            connectedApiRef.current = api;
            walletIdRef.current = lastWalletId;
            setWallet(info);
            setStatus(statusForWallet(info));
            startPolling();
            reportWalletNetworkId(info.networkId);
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
    // Deliberately only keyed on networkReady — this is the *load-time*
    // reconnect and must run exactly once, against whatever network hint was
    // settled on by the time it fires. A network switch *after* that goes
    // through requestSwitch below, called imperatively by the Network
    // Manager — it is never triggered by this effect re-running.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [networkReady]);

  // Registers the imperative switch handler the Network Manager calls when
  // the user requests a network switch (see network/networkBridge.ts and the
  // requestNetworkSwitch flow in NetworkProvider.tsx). Kept as a ref-backed
  // "latest callback" registration — the function registered never goes
  // stale between renders, but the registration effect itself only runs
  // once, so there's no churn of (de)registering on every render.
  const requestSwitchRef = useRef<(id: NetworkId) => Promise<void>>(async () => {
    throw new Error("Wallet not ready yet.");
  });

  // Reassigned after every render (deliberately no dependency array) so the
  // registered function always closes over the latest state/refs without
  // needing an exhaustive dependency list — this runs as an effect (not
  // during render) purely to satisfy the rule that refs are a render-time
  // read-only escape hatch.
  useEffect(() => {
    requestSwitchRef.current = (id: NetworkId): Promise<void> => {
      if (!connectedApiRef.current) {
        return Promise.reject(new NoWalletConnectedError());
      }

      const walletId = walletIdRef.current;
      const entry = walletId
        ? (pickerWalletsRef.current.find((w) => w.id === walletId) ?? getWalletPickerList().find((w) => w.id === walletId))
        : undefined;

      if (!entry?.api) {
        handleDisconnected();
        setErrorMessage(`Switch to ${network.label} failed. Reconnect your wallet to continue.`);
        return Promise.reject(new Error("Original wallet reference is no longer available. Reconnect and try again."));
      }

      const myGeneration = ++generationRef.current;
      setStatus("connecting");
      setErrorMessage(null);

      return withTimeout(
        connectWallet(entry.api, id),
        CONNECT_TIMEOUT_MS,
        () => new WalletError("internal-error", "Wallet did not respond while switching networks."),
      )
        .then(async (connected) => {
          if (generationRef.current !== myGeneration) return;
          const info = await loadWalletInfo(connected, walletNameRef.current);
          if (generationRef.current !== myGeneration) return;
          connectedApiRef.current = connected;
          setWallet(info);
          setStatus(statusForWallet(info));
          startPolling();
          reportWalletNetworkId(info.networkId);
        })
        .catch((err) => {
          if (generationRef.current !== myGeneration) throw err;
          console.warn("[wallet] network switch failed, disconnecting:", toWalletError(err).message);
          handleDisconnected();
          setErrorMessage(`Couldn't switch your wallet to ${network.label}. Reconnect to continue.`);
          throw err;
        });
    };
  });

  useEffect(() => {
    setWalletNetworkBridge({
      requestSwitch: (id) => requestSwitchRef.current(id),
    });
    return () => setWalletNetworkBridge(null);
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const value = useMemo<WalletContextValue>(
    () => ({
      status,
      wallet,
      errorMessage,
      pickerWallets,
      connectingWalletId,
      isModalOpen,
      openModal,
      closeModal,
      connectTo,
      disconnect,
      getConnectedApi,
    }),
    [
      status,
      wallet,
      errorMessage,
      pickerWallets,
      connectingWalletId,
      isModalOpen,
      openModal,
      closeModal,
      connectTo,
      disconnect,
      getConnectedApi,
    ],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}
