"use client";

import { Check, ChevronDown, Globe, Loader2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { NETWORK_CONFIGS, NETWORK_IDS } from "./networkConfig";
import { useNetworkContext } from "./networkContext";

/**
 * The one place in the UI that switches networks — reused as-is in the
 * navbar, the wallet connect modal, and the connected-wallet dropdown (see
 * Navbar, WalletModal, WalletDropdown) so there is exactly one switching
 * code path. Selecting a network only ever calls the Network Manager's
 * `requestNetworkSwitch` — it has no idea a wallet exists. If a wallet is
 * connected, the Network Manager asks it to switch (via networkBridge.ts)
 * and this component's `networkId` only updates once the wallet confirms —
 * see NetworkProvider.tsx.
 */
export function NetworkSwitcher({ className }: { className?: string }) {
  const { networkId, network, switching, switchError, requestNetworkSwitch } = useNetworkContext();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Network: ${network.label}. Click to switch networks.`}
          disabled={switching}
          className={cn(
            "flex h-8 items-center gap-1.5 rounded-full border border-border bg-white/[0.02] px-3 text-xs font-medium text-foreground/90 transition-colors hover:border-border-hover hover:bg-white/[0.04] disabled:cursor-not-allowed disabled:opacity-60",
            className,
          )}
        >
          {switching ? (
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden="true" />
          ) : (
            <span
              aria-hidden="true"
              className={cn(
                "size-1.5 rounded-full",
                network.faucet.available ? "bg-emerald-400" : "bg-amber-400",
              )}
            />
          )}
          {switching ? "Switching…" : network.label}
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        {switchError && (
          <p role="alert" className="px-2 pb-1.5 text-[11px] text-destructive">
            {switchError}
          </p>
        )}
        {NETWORK_IDS.map((id) => {
          const config = NETWORK_CONFIGS[id];
          const active = id === networkId;
          return (
            <DropdownMenuItem
              key={id}
              disabled={switching}
              className="flex-col items-start gap-0.5 py-2"
              onSelect={() => {
                if (id !== networkId) requestNetworkSwitch(id);
              }}
            >
              <span className="flex w-full items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 font-medium text-foreground">
                  <Globe className="size-3.5 text-muted-foreground" />
                  {config.label}
                </span>
                {active && <Check className="size-3.5 shrink-0 text-primary" aria-label="Active network" />}
              </span>
              <span
                className={cn(
                  "pl-5 text-[11px]",
                  config.faucet.available ? "text-emerald-400" : "text-muted-foreground",
                )}
              >
                {config.faucet.message}
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
