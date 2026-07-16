"use client";

import { useCallback, useEffect, useState } from "react";
import { getPpmStatusByKey, getTreasuryBalanceByKey, getTreasuryHistory } from "@/services/matcher/api";
import { matcher } from "@/services/matcher/matcherClient";
import { nativeAssetKeyHex } from "@/lib/nativeAsset";
import type { MatcherPpmStatus, MatcherTreasuryBalance, MatcherTreasuryEvent } from "@/types/matcher";

const HISTORY_LIMIT = 50;
const REFRESH_MS = 30_000;

export interface TreasuryState {
  balance: MatcherTreasuryBalance | null;
  ppmStatus: MatcherPpmStatus | null;
  history: MatcherTreasuryEvent[];
  loading: boolean;
  error: string | null;
}

/**
 * The Treasury's own top-level state for the real native tNIGHT asset —
 * distinct from useMarketData's per-trading-pair PPM liquidity (which is
 * keyed by deriveAssetKey(pair-as-order-asset), not the raw native token
 * type — see services/matcher/api.ts's doc comment). This is what the
 * Treasury page, Overview's Protocol Liquidity card, and Settings'
 * Developer section all read from.
 */
export function useTreasury(): TreasuryState & { refresh: () => void } {
  const [state, setState] = useState<TreasuryState>({
    balance: null,
    ppmStatus: null,
    history: [],
    loading: true,
    error: null,
  });

  const load = useCallback(async () => {
    try {
      const assetKey = nativeAssetKeyHex();
      const [balance, ppmStatus, historyResponse] = await Promise.all([
        getTreasuryBalanceByKey(assetKey),
        getPpmStatusByKey(assetKey),
        getTreasuryHistory(HISTORY_LIMIT),
      ]);
      setState({ balance, ppmStatus, history: historyResponse.events, loading: false, error: null });
    } catch (err) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : "Failed to load Treasury data",
      }));
    }
  }, []);

  useEffect(() => {
    void load();
    const unsubscribe = matcher.subscribeMessages((message) => {
      switch (message.type) {
        case "treasury.deposited":
        case "treasury.withdrawn":
        case "treasury.reserved":
        case "treasury.released":
          void load();
          return;
        default:
          return;
      }
    });
    const interval = window.setInterval(() => void load(), REFRESH_MS);
    return () => {
      unsubscribe();
      window.clearInterval(interval);
    };
  }, [load]);

  return { ...state, refresh: () => void load() };
}
