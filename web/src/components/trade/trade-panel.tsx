"use client";

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CheckCircle2, ChevronDown, Loader2, ShieldCheck, WalletMinimal } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Slider } from "@/components/ui/slider";
import { WalletCard } from "@/components/trade/wallet-card";
import { useSubmitOrder } from "@/hooks/use-submit-order";
import { useWallet } from "@/wallet/walletHooks";
import { useNetworkContext } from "@/network/networkContext";
import { ASSET_PAIRS } from "@/lib/mock/market";
import { formatAmount } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { AssetPair, ExpiryOption, Order, OrderSide } from "@/lib/types";

const EXPIRY_OPTIONS: ExpiryOption[] = ["10m", "30m", "1h", "GTC"];
const FEE_BPS = 10; // 0.10%
const INTEGER_FORMAT = /^[0-9]+$/;

interface TradePanelProps {
  pair: AssetPair;
  onPairChange: (pair: AssetPair) => void;
  midPrice: number;
  onOrderCreated: (order: Order) => void;
}

export function TradePanel({
  pair,
  onPairChange,
  midPrice,
  onOrderCreated,
}: TradePanelProps) {
  const wallet = useWallet();
  const { switching: networkSwitching } = useNetworkContext();
  const { state: submitState, submit, reset: resetSubmit } = useSubmitOrder();

  const [side, setSide] = useState<OrderSide>("BUY");
  const [amount, setAmount] = useState("");
  const [limitPrice, setLimitPrice] = useState(() => Math.round(midPrice).toString());
  const [expiry, setExpiry] = useState<ExpiryOption>("1h");

  const submitting = submitState.phase === "signing" || submitState.phase === "disclosing";
  const success = submitState.phase === "success";
  const submitError = submitState.phase === "error" ? submitState.message : null;

  const availableBalance = Number(wallet.balanceFor(side === "BUY" ? pair.quote : pair.base));
  const balanceSymbol = side === "BUY" ? pair.quote : pair.base;

  const parsedAmount = Number(amount);
  const parsedPrice = Number(limitPrice);
  const isAmountValid =
    amount.trim() !== "" && parsedAmount > 0 && INTEGER_FORMAT.test(amount.trim());
  const isPriceValid =
    limitPrice.trim() !== "" && parsedPrice > 0 && INTEGER_FORMAT.test(limitPrice.trim());

  const cost = isAmountValid && isPriceValid ? parsedAmount * parsedPrice : 0;
  const fee = cost * (FEE_BPS / 10_000);

  const affordable =
    side === "BUY" ? cost + fee <= availableBalance : parsedAmount <= availableBalance;

  const canSubmit = isAmountValid && isPriceValid && affordable && !submitting && !networkSwitching;

  const sliderValue = useMemo(() => {
    if (side === "SELL") {
      if (availableBalance <= 0) return 0;
      return Math.min(100, Math.round((parsedAmount / availableBalance) * 100));
    }
    if (parsedPrice <= 0 || availableBalance <= 0) return 0;
    const maxAmount = availableBalance / parsedPrice;
    return Math.min(100, Math.round((parsedAmount / maxAmount) * 100));
  }, [availableBalance, parsedAmount, parsedPrice, side]);

  // Reset the success/error banner once the user starts changing the order again.
  useEffect(() => {
    if (submitState.phase === "success" || submitState.phase === "error") resetSubmit();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-arm on user edits, not on resetSubmit identity
  }, [side, amount, limitPrice, expiry, pair.id]);

  function applySliderPct(pct: number) {
    if (side === "SELL") {
      setAmount(Math.round(availableBalance * (pct / 100)).toString());
      return;
    }
    const price = parsedPrice > 0 ? parsedPrice : midPrice;
    if (price <= 0) return;
    setAmount(Math.round((availableBalance / price) * (pct / 100)).toString());
  }

  async function handleSubmit() {
    if (!wallet.isConnected) {
      wallet.openModal();
      return;
    }
    if (!canSubmit) return;
    const order = await submit({
      pair,
      side,
      amount,
      price: limitPrice,
      expiry,
    });
    if (order) {
      onOrderCreated(order);
      setAmount("");
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: "easeOut", delay: 0.1 }}
      className="flex h-full flex-col gap-5 overflow-y-auto p-4 md:p-5"
    >
      <div
        role="radiogroup"
        aria-label="Order side"
        className="grid grid-cols-2 gap-1 rounded-lg border border-border bg-white/[0.02] p-1"
      >
        <button
          role="radio"
          aria-checked={side === "BUY"}
          onClick={() => setSide("BUY")}
          className={cn(
            "rounded-md py-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            side === "BUY"
              ? "bg-primary text-white"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          Buy
        </button>
        <button
          role="radio"
          aria-checked={side === "SELL"}
          onClick={() => setSide("SELL")}
          className={cn(
            "rounded-md py-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            side === "SELL"
              ? "bg-primary text-white"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          Sell
        </button>
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">
          Asset
        </label>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex w-full items-center justify-between rounded-md border border-border bg-white/[0.02] px-3 py-2 text-sm text-foreground transition-colors hover:border-border-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <span>
                {pair.base} / {pair.quote}
              </span>
              <ChevronDown className="size-4 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-[--radix-dropdown-menu-trigger-width]">
            {ASSET_PAIRS.map((p) => (
              <DropdownMenuItem key={p.id} onSelect={() => onPairChange(p)}>
                {p.base} / {p.quote}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <label htmlFor="amount" className="text-xs font-medium text-muted-foreground">
            Amount
          </label>
          <WalletCard
            symbol={balanceSymbol}
            balance={availableBalance}
            onMax={() => applySliderPct(100)}
          />
        </div>
        <div className="relative">
          <input
            id="amount"
            inputMode="numeric"
            placeholder="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ""))}
            aria-invalid={amount !== "" && !isAmountValid}
            className={cn(
              "w-full rounded-md border bg-white/[0.02] px-3 py-2.5 pr-20 font-mono text-sm tabular-nums text-foreground outline-none transition-colors",
              "focus-visible:ring-2 focus-visible:ring-ring",
              amount !== "" && !isAmountValid
                ? "border-destructive/50"
                : "border-border focus-visible:border-primary",
            )}
          />
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
            {pair.base}
          </span>
        </div>
        <div className="pt-1">
          <Slider
            aria-label="Order size"
            value={[sliderValue]}
            max={100}
            step={1}
            onValueChange={([v]) => applySliderPct(v)}
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="limit-price" className="text-xs font-medium text-muted-foreground">
          Limit Price
        </label>
        <div className="relative">
          <input
            id="limit-price"
            inputMode="numeric"
            placeholder="0"
            value={limitPrice}
            onChange={(e) => setLimitPrice(e.target.value.replace(/[^0-9]/g, ""))}
            aria-invalid={limitPrice !== "" && !isPriceValid}
            className={cn(
              "w-full rounded-md border bg-white/[0.02] px-3 py-2.5 pr-16 font-mono text-sm tabular-nums text-foreground outline-none transition-colors",
              "focus-visible:ring-2 focus-visible:ring-ring",
              limitPrice !== "" && !isPriceValid
                ? "border-destructive/50"
                : "border-border focus-visible:border-primary",
            )}
          />
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
            {pair.quote}
          </span>
        </div>
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">
          Expiration
        </label>
        <div className="grid grid-cols-4 gap-1.5">
          {EXPIRY_OPTIONS.map((opt) => (
            <button
              key={opt}
              onClick={() => setExpiry(opt)}
              className={cn(
                "rounded-md border py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                expiry === opt
                  ? "border-primary/50 bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {opt}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-2 rounded-lg border border-border bg-white/[0.015] p-3">
        <p className="text-xs font-medium text-muted-foreground">
          Order Summary
        </p>
        <div className="space-y-1.5 font-mono text-xs tabular-nums">
          <div className="flex justify-between">
            <span className="text-muted-foreground">You pay</span>
            <span className="text-foreground">
              {isAmountValid && isPriceValid
                ? side === "BUY"
                  ? `${formatAmount(cost + fee)} ${pair.quote}`
                  : `${formatAmount(parsedAmount)} ${pair.base}`
                : "—"}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">You receive</span>
            <span className="text-foreground">
              {isAmountValid && isPriceValid
                ? side === "BUY"
                  ? `${formatAmount(parsedAmount)} ${pair.base}`
                  : `${formatAmount(cost - fee)} ${pair.quote}`
                : "—"}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Fee</span>
            <span className="text-foreground/80">
              {isAmountValid && isPriceValid
                ? `${formatAmount(fee)} ${pair.quote}`
                : "—"}
            </span>
          </div>
        </div>
        {!affordable && isAmountValid && isPriceValid && (
          <p className="text-xs text-destructive">
            Insufficient {balanceSymbol} balance.
          </p>
        )}
        {submitError && <p className="text-xs text-destructive">{submitError}</p>}
        <div className="flex items-start gap-2 border-t border-border pt-2.5">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-primary" />
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Your order remains confidential. Only a cryptographic commitment
            is stored on-chain.
          </p>
        </div>
      </div>

      <button
        onClick={handleSubmit}
        disabled={wallet.isConnected && !canSubmit}
        className={cn(
          "relative flex h-11 items-center justify-center gap-2 rounded-md text-sm font-semibold transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          "disabled:cursor-not-allowed disabled:opacity-40",
          side === "BUY"
            ? "bg-primary text-white hover:bg-primary/90"
            : "bg-white text-black hover:bg-white/90",
        )}
      >
        <AnimatePresence mode="wait" initial={false}>
          {!wallet.isConnected ? (
            <motion.span
              key="connect"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex items-center gap-2"
            >
              <WalletMinimal className="size-4" />
              Connect Wallet
            </motion.span>
          ) : networkSwitching ? (
            <motion.span
              key="network-switching"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex items-center gap-2"
            >
              <Loader2 className="size-4 animate-spin" />
              Switching Network
            </motion.span>
          ) : submitting ? (
            <motion.span
              key="loading"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex items-center gap-2"
            >
              <Loader2 className="size-4 animate-spin" />
              {submitState.phase === "signing" ? "Awaiting Wallet Signature" : "Submitting Order"}
            </motion.span>
          ) : success ? (
            <motion.span
              key="success"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              className="flex items-center gap-2"
            >
              <CheckCircle2 className="size-4" />
              Order Submitted
            </motion.span>
          ) : (
            <motion.span
              key="idle"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              Submit Order
            </motion.span>
          )}
        </AnimatePresence>
      </button>
    </motion.div>
  );
}
