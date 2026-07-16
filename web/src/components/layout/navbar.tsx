"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { AlertTriangle, Loader2, Menu, WalletMinimal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { useWallet } from "@/wallet/walletHooks";
import { WalletDropdown } from "@/wallet/WalletDropdown";
import { NetworkSwitcher } from "@/network/NetworkSwitcher";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { label: "Dashboard", href: "/dashboard" },
  { label: "Trade", href: "/trade" },
  { label: "My Orders", href: "/orders" },
  { label: "Activity", href: "/activity" },
  { label: "Settings", href: "/settings" },
];

function isActive(href: string, pathname: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavLinks({ className }: { className?: string }) {
  const pathname = usePathname();
  return (
    <nav className={cn("flex items-center gap-1", className)}>
      {NAV_ITEMS.map((item) => {
        const active = isActive(item.href, pathname);
        return (
          <Link
            key={item.label}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "relative rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              active
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {item.label}
            {active && (
              <span className="absolute inset-x-3 -bottom-[1px] h-px bg-primary" />
            )}
          </Link>
        );
      })}
    </nav>
  );
}

function WalletPill() {
  const { status, wallet, errorMessage, openModal } = useWallet();

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

  if (wallet && (status === "connected" || status === "unsupported-network")) {
    return <WalletDropdown />;
  }

  // idle / unavailable / error / disconnected
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
        onClick={openModal}
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
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
      <div className="flex h-14 items-center justify-between gap-4 px-4 md:px-6">
        <div className="flex items-center gap-8">
          <Link
            href="/"
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
          <div className="hidden items-center gap-2 sm:flex">
            <NetworkSwitcher />
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
                      isActive(item.href, pathname)
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground",
                    )}
                  >
                    {item.label}
                  </Link>
                ))}
                <div className="mt-4 flex flex-col items-start gap-2 border-t border-border pt-4 sm:hidden">
                  <NetworkSwitcher />
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
