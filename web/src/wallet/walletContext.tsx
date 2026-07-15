"use client";

import { createContext, useContext } from "react";
import type { ConnectedAPI } from "@midnight-ntwrk/dapp-connector-api";
import type { ConnectedWalletInfo, PickerWallet, WalletStatus } from "./walletTypes";

export interface WalletContextValue {
  status: WalletStatus;
  wallet: ConnectedWalletInfo | null;
  errorMessage: string | null;
  /** Wallets available to the picker modal, refreshed live while it's open. */
  pickerWallets: PickerWallet[];
  /** id of the wallet currently mid-connect, so its card alone shows a spinner. */
  connectingWalletId: string | null;
  isModalOpen: boolean;
  openModal: () => void;
  closeModal: () => void;
  /** Connects to the picker entry with this id. Must be called synchronously
   *  from a user gesture (e.g. a wallet card's onClick). */
  connectTo: (id: string) => void;
  disconnect: () => void;
  getConnectedApi: () => ConnectedAPI | null;
}

export const WalletContext = createContext<WalletContextValue | null>(null);

export function useWalletContext(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWalletContext must be used within a WalletProvider");
  return ctx;
}
