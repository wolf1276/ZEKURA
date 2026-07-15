"use client";

import { Loader2 } from "lucide-react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import type { PickerWallet } from "./walletTypes";

interface WalletCardProps {
  wallet: PickerWallet;
  connecting: boolean;
  disabled: boolean;
  onSelect: () => void;
}

function WalletIcon({ wallet }: { wallet: PickerWallet }) {
  if (wallet.icon) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- wallet icons are remote/data URLs, not optimizable
      <img
        src={wallet.icon}
        alt=""
        width={32}
        height={32}
        className="size-8 shrink-0 rounded-lg object-contain"
      />
    );
  }
  const initial = wallet.name.trim().charAt(0).toUpperCase() || "?";
  return (
    <div
      aria-hidden="true"
      className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-sm font-semibold text-primary"
    >
      {initial}
    </div>
  );
}

export function WalletCard({ wallet, connecting, disabled, onSelect }: WalletCardProps) {
  const interactive = !disabled;

  function handleClick() {
    if (!interactive) return;
    if (!wallet.installed) {
      if (wallet.downloadUrl) window.open(wallet.downloadUrl, "_blank", "noopener,noreferrer");
      return;
    }
    onSelect();
  }

  return (
    <motion.button
      type="button"
      onClick={handleClick}
      disabled={disabled && wallet.installed}
      aria-label={
        wallet.installed
          ? `Connect ${wallet.name}`
          : `Install ${wallet.name} (opens in a new tab)`
      }
      whileHover={interactive ? { y: -2 } : undefined}
      whileTap={interactive ? { scale: 0.98 } : undefined}
      transition={{ duration: 0.15, ease: "easeOut" }}
      className={cn(
        "flex w-full items-center gap-3 rounded-xl border border-border bg-white/[0.02] px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        interactive &&
          "hover:border-primary/40 hover:bg-primary/[0.06] hover:shadow-[0_0_0_1px_rgba(109,94,245,0.25),0_10px_28px_-10px_rgba(109,94,245,0.45)]",
        disabled && wallet.installed && "pointer-events-none opacity-40",
      )}
    >
      <WalletIcon wallet={wallet} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-1.5 truncate text-sm font-medium text-foreground">
          <span className="truncate">{wallet.name}</span>
          {wallet.recommended && (
            <span className="shrink-0 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
              Recommended
            </span>
          )}
        </span>
        <span className={cn("text-xs", wallet.installed ? "text-emerald-400" : "text-muted-foreground")}>
          {wallet.installed ? "Installed" : "Not Installed"}
        </span>
      </div>
      {connecting ? (
        <Loader2 className="size-4 shrink-0 animate-spin text-primary" aria-hidden="true" />
      ) : !wallet.installed ? (
        <span className="shrink-0 text-xs font-medium text-primary">Install →</span>
      ) : null}
    </motion.button>
  );
}
