"use client";

import { Wallet } from "lucide-react";
import { formatAmount } from "@/lib/format";

interface WalletCardProps {
  symbol: string;
  balance: number;
  onMax?: () => void;
}

export function WalletCard({ symbol, balance, onMax }: WalletCardProps) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <Wallet className="size-3.5" />
        Available
        <span className="balance-value font-mono tabular-nums text-foreground/80">
          {formatAmount(balance)} {symbol}
        </span>
      </span>
      {onMax && (
        <button
          type="button"
          onClick={onMax}
          className="rounded px-1.5 py-0.5 font-medium text-primary transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Max
        </button>
      )}
    </div>
  );
}
