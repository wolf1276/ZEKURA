"use client";

import Link from "next/link";
import { useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  Copy,
  ExternalLink,
  Loader2,
  LogOut,
  ShieldCheck,
  Menu,
  WalletMinimal,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { useWallet } from "@/hooks/use-wallet";
import { truncateAddress } from "@/lib/format";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { label: "Dashboard", href: "#" },
  { label: "Trade", href: "#", active: true },
  { label: "My Orders", href: "#" },
  { label: "Activity", href: "#" },
  { label: "Settings", href: "#" },
];

/** https://docs.midnight.network/relnotes/network — documented block explorers per network. */
const EXPLORER_URL: Record<string, string> = {
  preview: "https://preview.midnightexplorer.com/",
  preprod: "https://preprod.midnightexplorer.com/",
  mainnet: "https://midnightexplorer.com/",
};

function NavLinks({ className }: { className?: string }) {
  return (
    <nav className={cn("flex items-center gap-1", className)}>
      {NAV_ITEMS.map((item) => (
        <Link
          key={item.label}
          href={item.href}
          aria-current={item.active ? "page" : undefined}
          className={cn(
            "relative rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            item.active
              ? "text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {item.label}
          {item.active && (
            <span className="absolute inset-x-3 -bottom-[1px] h-px bg-primary" />
          )}
        </Link>
      ))}
    </nav>
  );
}

function WalletPill() {
  const { status, wallet, errorMessage, expectedNetworkId, connect, disconnect } = useWallet();

  async function copyAddress() {
    if (!wallet) return;
    await navigator.clipboard.writeText(wallet.unshieldedAddress);
    toast.success("Address copied");
  }

  if (status === "connecting") {
    return (
      <Button
        variant="outline"
        disabled
        className="h-8 gap-1.5 rounded-full border-border bg-white/[0.02] px-3 font-mono text-xs text-foreground/90"
      >
        <Loader2 className="size-3.5 animate-spin" /> Connecting…
      </Button>
    );
  }

  if (status === "connected" || status === "wrong-network" || status === "disconnected") {
    if (status === "disconnected" || !wallet) {
      return (
        <Button
          variant="outline"
          onClick={connect}
          className="h-8 gap-1.5 rounded-full border-border bg-white/[0.02] px-3 text-xs text-foreground/90 hover:border-border-hover hover:bg-white/[0.04]"
        >
          <WalletMinimal className="size-3.5" /> Reconnect
        </Button>
      );
    }

    const wrongNetwork = status === "wrong-network";
    const explorerUrl = EXPLORER_URL[wallet.networkId] ?? EXPLORER_URL.preprod;

    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            className={cn(
              "h-8 gap-1.5 rounded-full border-border bg-white/[0.02] px-3 font-mono text-xs text-foreground/90 hover:border-border-hover hover:bg-white/[0.04]",
              wrongNetwork && "border-destructive/50 text-destructive",
            )}
          >
            {wrongNetwork ? (
              <AlertTriangle className="size-3.5" />
            ) : (
              <span className="size-1.5 rounded-full bg-primary" aria-hidden="true" />
            )}
            {wrongNetwork ? "Wrong Network" : truncateAddress(wallet.unshieldedAddress)}
            <ChevronDown className="size-3.5 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <div className="px-2 py-1.5">
            <p className="text-xs text-muted-foreground">
              {wallet.walletName} · {wallet.networkId}
            </p>
            <p className="mt-0.5 font-mono text-sm text-foreground">
              {truncateAddress(wallet.unshieldedAddress, 10, 6)}
            </p>
          </div>
          {wrongNetwork && (
            <p className="px-2 pb-1.5 text-xs text-destructive">
              Switch your wallet to {expectedNetworkId} and reconnect.
            </p>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem className="gap-2" onSelect={copyAddress}>
            <Copy className="size-4" /> Copy address
          </DropdownMenuItem>
          <DropdownMenuItem
            className="gap-2"
            onSelect={() => window.open(explorerUrl, "_blank", "noopener,noreferrer")}
          >
            <ExternalLink className="size-4" /> View on explorer
          </DropdownMenuItem>
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
    );
  }

  // idle / unavailable / error
  return (
    <div className="flex items-center gap-2">
      {errorMessage && (
        <span
          className="hidden max-w-40 truncate text-xs text-destructive md:inline"
          title={errorMessage}
        >
          {errorMessage}
        </span>
      )}
      <Button
        variant="outline"
        onClick={connect}
        className="h-8 gap-1.5 rounded-full border-border bg-white/[0.02] px-3 text-xs text-foreground/90 hover:border-border-hover hover:bg-white/[0.04]"
      >
        {status === "error" || status === "unavailable" ? (
          <AlertTriangle className="size-3.5 text-destructive" />
        ) : (
          <WalletMinimal className="size-3.5" />
        )}
        Connect Wallet
      </Button>
    </div>
  );
}

export function Navbar() {
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
      <div className="flex h-14 items-center justify-between gap-4 px-4 md:px-6">
        <div className="flex items-center gap-8">
          <Link
            href="#"
            className="flex items-center gap-2 font-semibold tracking-tight text-foreground"
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- next/image can't optimize .ico */}
            <img
              src="/zekura-mark.ico"
              alt=""
              width={22}
              height={22}
              className="size-[22px] rounded-md"
            />
            <span className="text-[15px]">Zekura</span>
          </Link>
          <NavLinks className="hidden md:flex" />
        </div>

        <div className="flex items-center gap-2">
          <div className="hidden sm:block">
            <WalletPill />
          </div>
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="md:hidden"
                aria-label="Open navigation menu"
              >
                <Menu className="size-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="w-72 bg-background">
              <div className="mt-8 flex flex-col gap-1 px-4">
                {NAV_ITEMS.map((item) => (
                  <Link
                    key={item.label}
                    href={item.href}
                    onClick={() => setOpen(false)}
                    className={cn(
                      "rounded-md px-3 py-2 text-sm font-medium",
                      item.active
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground",
                    )}
                  >
                    {item.label}
                  </Link>
                ))}
                <div className="mt-4 border-t border-border pt-4 sm:hidden">
                  <WalletPill />
                </div>
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </header>
  );
}
