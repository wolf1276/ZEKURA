"use client";

import { useCallback, useSyncExternalStore } from "react";

export interface Settings {
  autoConnect: boolean;
  compactMode: boolean;
  reduceMotion: boolean;
  notifyFilled: boolean;
  notifySettled: boolean;
  notifyErrors: boolean;
  notifyBrowser: boolean;
  hidePortfolio: boolean;
  hideBalances: boolean;
  privacyMode: boolean;
}

const DEFAULTS: Settings = {
  autoConnect: true,
  compactMode: false,
  reduceMotion: false,
  notifyFilled: true,
  notifySettled: true,
  notifyErrors: true,
  notifyBrowser: false,
  hidePortfolio: false,
  hideBalances: false,
  privacyMode: false,
};

const STORAGE_PREFIX = "zekura:setting:";

export function readSetting<K extends keyof Settings>(key: K): Settings[K] {
  try {
    const raw = window.localStorage.getItem(`${STORAGE_PREFIX}${key}`);
    if (raw === null) return DEFAULTS[key];
    return JSON.parse(raw) as Settings[K];
  } catch {
    return DEFAULTS[key];
  }
}

function writeSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
  try {
    window.localStorage.setItem(`${STORAGE_PREFIX}${key}`, JSON.stringify(value));
  } catch {
    // Non-fatal — setting applies for this session only
  }
}

const listeners = new Map<string, Set<() => void>>();

function subscribe(key: string, listener: () => void): () => void {
  if (!listeners.has(key)) listeners.set(key, new Set());
  listeners.get(key)!.add(listener);
  return () => {
    listeners.get(key)?.delete(listener);
  };
}

function emit(key: string): void {
  listeners.get(key)?.forEach((l) => l());
}

function createSnapshot<K extends keyof Settings>(key: K): () => Settings[K] {
  return () => readSetting(key);
}

export function useSetting<K extends keyof Settings>(key: K): [Settings[K], (value: Settings[K]) => void] {
  const value = useSyncExternalStore(
    (cb) => subscribe(key, cb),
    createSnapshot(key),
    () => DEFAULTS[key],
  );

  const setValue = useCallback(
    (v: Settings[K]) => {
      writeSetting(key, v);
      emit(key);
    },
    [key],
  );

  return [value, setValue];
}

export function useSettings(): Settings & {
  setAutoConnect: (v: boolean) => void;
  setCompactMode: (v: boolean) => void;
  setReduceMotion: (v: boolean) => void;
  setNotifyFilled: (v: boolean) => void;
  setNotifySettled: (v: boolean) => void;
  setNotifyErrors: (v: boolean) => void;
  setNotifyBrowser: (v: boolean) => void;
  setHidePortfolio: (v: boolean) => void;
  setHideBalances: (v: boolean) => void;
  setPrivacyMode: (v: boolean) => void;
} {
  const [autoConnect, setAutoConnect] = useSetting("autoConnect");
  const [compactMode, setCompactMode] = useSetting("compactMode");
  const [reduceMotion, setReduceMotion] = useSetting("reduceMotion");
  const [notifyFilled, setNotifyFilled] = useSetting("notifyFilled");
  const [notifySettled, setNotifySettled] = useSetting("notifySettled");
  const [notifyErrors, setNotifyErrors] = useSetting("notifyErrors");
  const [notifyBrowser, setNotifyBrowser] = useSetting("notifyBrowser");
  const [hidePortfolio, setHidePortfolio] = useSetting("hidePortfolio");
  const [hideBalances, setHideBalances] = useSetting("hideBalances");
  const [privacyMode, setPrivacyMode] = useSetting("privacyMode");

  return {
    autoConnect,
    compactMode,
    reduceMotion,
    notifyFilled,
    notifySettled,
    notifyErrors,
    notifyBrowser,
    hidePortfolio,
    hideBalances,
    privacyMode,
    setAutoConnect,
    setCompactMode,
    setReduceMotion,
    setNotifyFilled,
    setNotifySettled,
    setNotifyErrors,
    setNotifyBrowser,
    setHidePortfolio,
    setHideBalances,
    setPrivacyMode,
  };
}

export function applyDataAttributes(): void {
  if (typeof document === "undefined") return;
  const html = document.documentElement;
  for (const key of Object.keys(DEFAULTS) as (keyof Settings)[]) {
    if (key === "compactMode" || key === "reduceMotion") {
      const value = readSetting(key);
      html.dataset[key] = value ? "" : undefined;
    }
  }
}
