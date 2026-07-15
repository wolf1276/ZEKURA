"use client";

import { useState } from "react";
import { AlertTriangle, ChevronDown, Copy, ExternalLink, Eye, LogOut, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { truncateAddress } from "@/lib/format";
import { cn } from "@/lib/utils";
import { NETWORK_IDS, getNetworkConfig, isNetworkId } from "@/network/networkConfig";
import { useNetworkContext } from "@/network/networkContext";
import { useWallet } from "./walletHooks";
import { networkLabel } from "./walletTypes";
import { WalletAddressesModal } from "./WalletAddressesModal";

export function WalletDropdown() {
  const { status, wallet, disconnect } = useWallet();
  const { network } = useNetworkContext();
  const [addressesOpen, setAddressesOpen] = useState(false);

  if (!wallet) return null;

  const unsupportedNetwork = status === "unsupported-network";
  const supportedNetworkLabels = NETWORK_IDS.map((id) => getNetworkConfig(id).label).join(" or ");
  // Only link to an explorer for networks Zekura actually knows about — the
  // wallet can in principle report any id (e.g. 'mainnet', 'undeployed'),
  // and guessing a fallback explorer for those would point at the wrong
  // chain's data.
  const explorerUrl = isNetworkId(wallet.networkId) ? getNetworkConfig(wallet.networkId).explorerUrl : null;

  async function copyAddress() {
    if (!wallet) return;
    await navigator.clipboard.writeText(wallet.unshieldedAddress);
    toast.success("Address copied");
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            className={cn(
              "h-8 gap-1.5 rounded-full border-border bg-white/[0.02] px-3 font-mono text-xs text-foreground/90 hover:border-border-hover hover:bg-white/[0.04]",
              unsupportedNetwork && "border-destructive/50 text-destructive",
            )}
          >
            {unsupportedNetwork ? (
              <AlertTriangle className="size-3.5" />
            ) : (
              <span className="size-1.5 rounded-full bg-primary" aria-hidden="true" />
            )}
            {unsupportedNetwork ? "Unsupported Network" : truncateAddress(wallet.unshieldedAddress)}
            <ChevronDown className="size-3.5 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <div className="px-2 py-1.5">
            <p className="text-xs text-muted-foreground">
              {wallet.walletName} · {networkLabel(wallet.networkId)}
            </p>
            <p className="mt-0.5 font-mono text-sm text-foreground">
              {truncateAddress(wallet.unshieldedAddress, 10, 6)}
            </p>
            <p className={cn("mt-1 text-[11px]", network.faucet.available ? "text-emerald-400" : "text-muted-foreground")}>
              {network.faucet.message}
            </p>
          </div>
          {unsupportedNetwork && (
            <p className="px-2 pb-1.5 text-xs text-destructive">
              <span className="font-medium">Unsupported network.</span> Zekura only supports{" "}
              {supportedNetworkLabels}. Switch your wallet to continue.
            </p>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem className="gap-2" onSelect={copyAddress}>
            <Copy className="size-4" /> Copy Address
          </DropdownMenuItem>
          <DropdownMenuItem className="gap-2" onSelect={() => setAddressesOpen(true)}>
            <Eye className="size-4" /> View Addresses
          </DropdownMenuItem>
          {explorerUrl && (
            <DropdownMenuItem
              className="gap-2"
              onSelect={() => window.open(explorerUrl, "_blank", "noopener,noreferrer")}
            >
              <ExternalLink className="size-4" /> View on explorer
            </DropdownMenuItem>
          )}
          <DropdownMenuItem className="gap-2 text-muted-foreground">
            <ShieldCheck className="size-4" /> Confidential mode active
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="gap-2 text-destructive focus:text-destructive"
            onSelect={disconnect}
          >
            <LogOut className="size-4" /> Disconnect
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <WalletAddressesModal open={addressesOpen} onOpenChange={setAddressesOpen} wallet={wallet} />
    </>
  );
}
