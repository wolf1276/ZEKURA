"use client";

import { ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ASSET_PAIRS } from "@/lib/mock/market";
import { formatPercent, formatPrice } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { AssetPair } from "@/lib/types";

interface MarketHeaderProps {
  pair: AssetPair;
  onPairChange: (pair: AssetPair) => void;
  midPrice: number;
  change24h: number;
  volatility: "Low" | "Medium" | "High";
  activityLevel: "Low" | "Medium" | "High";
}

function StatBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs font-medium text-foreground/80">
      {label}
    </span>
  );
}

export function MarketHeader({
  pair,
  onPairChange,
  midPrice,
  change24h,
  volatility,
  activityLevel,
}: MarketHeaderProps) {
  const isPositive = change24h >= 0;

  return (
    <div className="flex flex-wrap items-center gap-x-8 gap-y-3 border-b border-border px-4 py-3 md:px-6">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="flex items-center gap-2 rounded-md py-1 text-left transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <span className="text-sm font-semibold tracking-tight text-foreground">
              {pair.base}/{pair.quote}
            </span>
            <ChevronDown className="size-4 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-48">
          {ASSET_PAIRS.map((p) => (
            <DropdownMenuItem
              key={p.id}
              onSelect={() => onPairChange(p)}
              className={cn(
                "justify-between",
                p.id === pair.id && "text-primary",
              )}
            >
              {p.base}/{p.quote}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="flex items-center gap-8">
        <div>
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Mid Price
          </p>
          <p className="mt-0.5 font-mono text-sm tabular-nums text-foreground">
            {formatPrice(midPrice)}
          </p>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
            24h Change
          </p>
          <p
            className={cn(
              "mt-0.5 font-mono text-sm tabular-nums",
              isPositive ? "text-primary" : "text-foreground/70",
            )}
          >
            {formatPercent(change24h)}
          </p>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Volatility
          </p>
          <div className="mt-1">
            <StatBadge label={volatility} />
          </div>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Activity
          </p>
          <div className="mt-1">
            <StatBadge label={`${activityLevel} Activity`} />
          </div>
        </div>
      </div>
    </div>
  );
}
