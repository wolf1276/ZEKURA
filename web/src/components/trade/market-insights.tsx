"use client";

import { motion } from "framer-motion";
import { Lock } from "lucide-react";
import { formatPrice } from "@/lib/format";
import type { MarketInsights as MarketInsightsData } from "@/lib/types";

interface MarketInsightsProps {
  insights: MarketInsightsData;
  quoteSymbol: string;
}

function RangeRow({
  label,
  low,
  high,
  quoteSymbol,
}: {
  label: string;
  low: number;
  high: number;
  quoteSymbol: string;
}) {
  return (
    <div className="flex items-center justify-between rounded-md border border-border px-3 py-2.5">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="font-mono text-sm tabular-nums text-foreground">
        {formatPrice(low)} – {formatPrice(high)} {quoteSymbol}
      </span>
    </div>
  );
}

function LiquidityRow({
  label,
  low,
  high,
  dot,
}: {
  label: string;
  low: number;
  high: number;
  dot: "strong" | "moderate" | "emerging";
}) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="flex items-center gap-2 text-sm text-foreground/85">
        <span
          className={
            dot === "strong"
              ? "size-2 rounded-full bg-primary"
              : dot === "moderate"
                ? "size-2 rounded-full border-2 border-primary bg-transparent"
                : "size-2 rounded-full border border-muted-foreground"
          }
          aria-hidden="true"
        />
        {label}
      </span>
      <span className="font-mono text-xs tabular-nums text-muted-foreground">
        {formatPrice(low)}–{formatPrice(high)}
      </span>
    </div>
  );
}

export function MarketInsightsPanel({
  insights,
  quoteSymbol,
}: MarketInsightsProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: "easeOut", delay: 0.05 }}
      className="flex h-full flex-col gap-6 overflow-y-auto p-4 md:p-5"
    >
      <div>
        <h2 className="text-sm font-semibold text-foreground">
          Market Insights
        </h2>
      </div>

      <section className="space-y-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Suggested Price Range
        </h3>
        <div className="space-y-2">
          <RangeRow
            label="Suggested Buy"
            low={insights.suggestedBuy.low}
            high={insights.suggestedBuy.high}
            quoteSymbol={quoteSymbol}
          />
          <RangeRow
            label="Suggested Sell"
            low={insights.suggestedSell.low}
            high={insights.suggestedSell.high}
            quoteSymbol={quoteSymbol}
          />
        </div>
      </section>

      <section className="space-y-1">
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Liquidity Zones
        </h3>
        <div className="divide-y divide-border/70">
          <LiquidityRow
            label="Strong Liquidity"
            low={insights.liquidityZones.strong.low}
            high={insights.liquidityZones.strong.high}
            dot="strong"
          />
          <LiquidityRow
            label="Moderate Liquidity"
            low={insights.liquidityZones.moderate.low}
            high={insights.liquidityZones.moderate.high}
            dot="moderate"
          />
          <LiquidityRow
            label="Emerging Interest"
            low={insights.liquidityZones.emerging.low}
            high={insights.liquidityZones.emerging.high}
            dot="emerging"
          />
        </div>
        <p className="pt-1 text-xs leading-relaxed text-muted-foreground/80">
          Confidence bands only — exact order counts or liquidity are never
          shown.
        </p>
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Market Activity
        </h3>
        <div className="flex flex-wrap gap-2">
          <span className="rounded-full bg-primary px-3 py-1 text-xs font-medium text-white">
            {insights.activityLevel} Activity
          </span>
          <span className="rounded-full border border-border px-3 py-1 text-xs font-medium text-foreground/80">
            Volatility: {insights.volatility}
          </span>
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Estimated Settlement Time
        </h3>
        <div className="rounded-md border border-dashed border-border px-3 py-2.5 text-sm text-foreground/85">
          ~{insights.estimatedSettlementSeconds.low}–
          {insights.estimatedSettlementSeconds.high} sec after private match
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Privacy Status
        </h3>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
          <Lock className="size-3.5" />
          Confidential — no public order book
        </span>
      </section>

      <p className="mt-auto border-t border-border pt-4 text-xs leading-relaxed text-muted-foreground/70">
        Market insights are generated from aggregated confidential activity.
        Individual orders and liquidity are never revealed.
      </p>
    </motion.div>
  );
}
