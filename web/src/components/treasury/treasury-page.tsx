"use client";

import { useState } from "react";
import { encodeUserAddress } from "@midnight-ntwrk/ledger-v8";
import { getNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { toHex } from "@midnight-ntwrk/midnight-js-utils";
import { MidnightBech32m, UnshieldedAddress } from "@midnight-ntwrk/wallet-sdk-address-format";
import { AlertTriangle, ArrowDownToLine, ArrowUpFromLine, Droplets, Shield, Wallet } from "lucide-react";
import { toast } from "sonner";
import { PageShell, Card } from "@/components/layout/page-shell";
import { useWallet } from "@/wallet/walletHooks";
import { useAdminAuth } from "@/hooks/use-admin-auth";
import { useTreasury } from "@/hooks/use-treasury";
import { depositTreasury, withdrawTreasury } from "@/services/matcher/api";
import { nativeAssetKeyHex } from "@/lib/nativeAsset";
import { formatAmount, formatRelativeTime, truncateAddress } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { MatcherTreasuryEventKind } from "@/types/matcher";

const RAW_UNITS_PER_TNIGHT = 1_000_000;

function toRawUnits(displayAmount: string): bigint {
  const n = Number(displayAmount);
  if (!Number.isFinite(n) || n <= 0) throw new Error("Enter a positive amount");
  return BigInt(Math.round(n * RAW_UNITS_PER_TNIGHT));
}

function toDisplay(raw: string): number {
  return Number(raw) / RAW_UNITS_PER_TNIGHT;
}

function riskLabel(risk: string): { label: string; className: string } {
  switch (risk) {
    case "critical":
      return { label: "Critical", className: "text-destructive" };
    case "elevated":
      return { label: "Elevated", className: "text-amber-500" };
    case "healthy":
      return { label: "Healthy", className: "text-emerald-500" };
    default:
      return { label: "Empty", className: "text-muted-foreground" };
  }
}

const EVENT_LABEL: Record<MatcherTreasuryEventKind, string> = {
  DEPOSIT: "Deposit",
  WITHDRAW: "Withdrawal",
  RESERVE: "Reserved",
  RELEASE: "Released",
  EXECUTE: "Protocol Trade",
};

function KpiCard({ label, value, sub, icon }: { label: string; value: React.ReactNode; sub?: React.ReactNode; icon: React.ReactNode }) {
  return (
    <Card className="p-5">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        {label}
      </div>
      <p className="mt-2 text-xl font-semibold tracking-tight text-foreground">{value}</p>
      {sub && <p className="mt-1 text-xs text-muted-foreground">{sub}</p>}
    </Card>
  );
}

function EventRow({ event }: { event: { kind: MatcherTreasuryEventKind; amount: string; actor: string; txId: string | null; createdAt: number } }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border/60 px-5 py-3 last:border-0">
      <div className="min-w-0">
        <p className="text-sm text-foreground/90">{EVENT_LABEL[event.kind]}</p>
        <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
          {event.txId ? truncateAddress(event.txId, 10, 6) : "pending"} · {formatRelativeTime(event.createdAt)}
        </p>
      </div>
      <p className="flex-none font-mono text-sm text-foreground/90">{formatAmount(toDisplay(event.amount), 4)} tNIGHT</p>
    </div>
  );
}

function HistoryList({ title, events }: { title: string; events: Array<{ kind: MatcherTreasuryEventKind; amount: string; actor: string; txId: string | null; createdAt: number }> }) {
  return (
    <div>
      <h3 className="mb-3 text-sm font-semibold text-foreground">{title}</h3>
      <Card className="divide-y divide-border/60">
        {events.length === 0 ? (
          <p className="px-5 py-6 text-center text-xs text-muted-foreground">None yet</p>
        ) : (
          events.map((e, i) => <EventRow key={`${e.txId ?? "pending"}-${i}`} event={e} />)
        )}
      </Card>
    </div>
  );
}

export function TreasuryPage() {
  const { wallet } = useWallet();
  const { isAdminAddress, signAdminRequest } = useAdminAuth();
  const { balance, ppmStatus, tzkrBalance, history, loading, refresh } = useTreasury();

  const [depositAmount, setDepositAmount] = useState("");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [withdrawTo, setWithdrawTo] = useState("");
  const [submitting, setSubmitting] = useState<"deposit" | "withdraw" | null>(null);

  const balanceDisplay = balance ? toDisplay(balance.balance) : 0;
  const availableDisplay = balance ? toDisplay(balance.available) : 0;
  const reservedDisplay = balance ? toDisplay(balance.reserved) : 0;
  const tzkrBalanceDisplay = tzkrBalance ? toDisplay(tzkrBalance.balance) : 0;
  const tzkrAvailableDisplay = tzkrBalance ? toDisplay(tzkrBalance.available) : 0;
  const tzkrReservedDisplay = tzkrBalance ? toDisplay(tzkrBalance.reserved) : 0;
  const utilizationPct = balance && Number(balance.balance) > 0 ? (Number(balance.reserved) / Number(balance.balance)) * 100 : 0;
  const isEmpty = !loading && balanceDisplay === 0;
  const risk = riskLabel(ppmStatus?.riskStatus ?? "empty");

  const deposits = history.filter((e) => e.kind === "DEPOSIT");
  const withdrawals = history.filter((e) => e.kind === "WITHDRAW");
  const trades = history.filter((e) => e.kind === "EXECUTE");

  async function handleDeposit() {
    setSubmitting("deposit");
    try {
      const amount = toRawUnits(depositAmount);
      const auth = await signAdminRequest();
      await depositTreasury({ auth, assetKey: nativeAssetKeyHex(), amount: amount.toString() });
      toast.success("Deposit submitted — the Treasury will update once the transaction confirms.");
      setDepositAmount("");
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Deposit failed");
    } finally {
      setSubmitting(null);
    }
  }

  async function handleWithdraw() {
    setSubmitting("withdraw");
    try {
      const amount = toRawUnits(withdrawAmount);
      const recipientBech32 = withdrawTo.trim() || wallet?.unshieldedAddress;
      if (!recipientBech32) throw new Error("Enter a recipient address");
      // encodeUserAddress expects the hex UserAddress form, not a bech32m
      // string — MidnightBech32m.parse(...).decode(...) is the conversion
      // (see @midnight-ntwrk/wallet-sdk-address-format).
      const recipientHex = MidnightBech32m.parse(recipientBech32).decode(UnshieldedAddress, getNetworkId()).hexString;
      const recipientUserAddress = toHex(encodeUserAddress(recipientHex));
      const auth = await signAdminRequest();
      await withdrawTreasury({ auth, assetKey: nativeAssetKeyHex(), amount: amount.toString(), recipientUserAddress });
      toast.success("Withdrawal submitted — the Treasury will update once the transaction confirms.");
      setWithdrawAmount("");
      refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Withdrawal failed");
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <PageShell title="Treasury" description="Protocol-owned liquidity backing the Proactive Market Maker — funded entirely by real deposits.">
      {isEmpty && (
        <Card className="mb-6 flex items-center gap-3 border-amber-500/30 bg-amber-500/[0.06] p-4">
          <AlertTriangle className="size-4 flex-none text-amber-500" />
          <p className="text-sm text-foreground/90">
            Treasury has not been funded yet. No protocol liquidity is available — trades can only match against other users&apos; resting orders until an administrator makes a real deposit.
          </p>
        </Card>
      )}

      <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <KpiCard label="Total Treasury Balance" value={`${formatAmount(balanceDisplay, 4)} tNIGHT`} icon={<Wallet className="size-3.5" />} />
        <KpiCard label="Available Liquidity" value={`${formatAmount(availableDisplay, 4)} tNIGHT`} icon={<Droplets className="size-3.5" />} />
        <KpiCard label="Reserved Liquidity" value={`${formatAmount(reservedDisplay, 4)} tNIGHT`} icon={<Shield className="size-3.5" />} />
        <KpiCard label="PPM Utilization" value={`${formatAmount(utilizationPct, 1)}%`} sub="reserved ÷ balance" icon={<Shield className="size-3.5" />} />
        <KpiCard
          label="Protocol Health"
          value={<span className={risk.className}>{risk.label}</span>}
          icon={<AlertTriangle className="size-3.5" />}
        />
      </div>

      <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KpiCard label="tZKR Treasury Balance" value={`${formatAmount(tzkrBalanceDisplay, 4)} tZKR`} icon={<Wallet className="size-3.5" />} />
        <KpiCard label="tZKR Available Liquidity" value={`${formatAmount(tzkrAvailableDisplay, 4)} tZKR`} icon={<Droplets className="size-3.5" />} />
        <KpiCard label="tZKR Reserved Liquidity" value={`${formatAmount(tzkrReservedDisplay, 4)} tZKR`} icon={<Shield className="size-3.5" />} />
      </div>

      {isAdminAddress && (
        <Card className="mb-8 p-5">
          <div className="mb-4 flex items-center gap-2">
            <Shield className="size-4 text-primary" />
            <h2 className="text-sm font-semibold text-foreground">Admin: Fund Treasury</h2>
          </div>
          <p className="mb-4 text-xs text-muted-foreground">
            Deposits/withdrawals are real on-chain transactions submitted by the Matcher on your behalf, authorized by a signature from your connected wallet ({wallet ? truncateAddress(wallet.unshieldedAddress, 10, 6) : "—"}).
          </p>
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-xs text-muted-foreground">Deposit amount (tNIGHT)</label>
              <div className="flex gap-2">
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={depositAmount}
                  onChange={(e) => setDepositAmount(e.target.value)}
                  placeholder="0.00"
                  className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                />
                <button
                  onClick={handleDeposit}
                  disabled={submitting !== null || !depositAmount}
                  className={cn(
                    "flex flex-none items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground transition-colors",
                    (submitting !== null || !depositAmount) && "cursor-not-allowed opacity-50",
                  )}
                >
                  <ArrowDownToLine className="size-3.5" />
                  {submitting === "deposit" ? "Depositing…" : "Deposit"}
                </button>
              </div>
            </div>
            <div>
              <label className="mb-1.5 block text-xs text-muted-foreground">Withdraw amount (tNIGHT)</label>
              <div className="flex gap-2">
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={withdrawAmount}
                  onChange={(e) => setWithdrawAmount(e.target.value)}
                  placeholder="0.00"
                  className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                />
                <button
                  onClick={handleWithdraw}
                  disabled={submitting !== null || !withdrawAmount}
                  className={cn(
                    "flex flex-none items-center gap-1.5 rounded-md border border-border px-3 py-2 text-xs font-medium text-foreground/90 transition-colors hover:border-border-hover",
                    (submitting !== null || !withdrawAmount) && "cursor-not-allowed opacity-50",
                  )}
                >
                  <ArrowUpFromLine className="size-3.5" />
                  {submitting === "withdraw" ? "Withdrawing…" : "Withdraw"}
                </button>
              </div>
              <input
                type="text"
                value={withdrawTo}
                onChange={(e) => setWithdrawTo(e.target.value)}
                placeholder={wallet ? `Recipient address (defaults to ${truncateAddress(wallet.unshieldedAddress, 8, 4)})` : "Recipient address"}
                className="mt-2 w-full rounded-md border border-border bg-transparent px-3 py-2 font-mono text-xs text-foreground outline-none focus:border-primary"
              />
            </div>
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <HistoryList title="Recent Deposits" events={deposits} />
        <HistoryList title="Recent Withdrawals" events={withdrawals} />
        <HistoryList title="Recent Trades" events={trades} />
      </div>
    </PageShell>
  );
}
