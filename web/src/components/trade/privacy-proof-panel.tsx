"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { AlertTriangle, Eye, EyeOff, Loader2, ShieldCheck } from "lucide-react";
import { fromHex } from "@midnight-ntwrk/midnight-js-utils";
import { useWallet } from "@/wallet/walletHooks";
import { useNetworkContext } from "@/network/networkContext";
import { getOnChainOrder, type OnChainOrderRecord } from "@/services/midnight/orderVerification";
import { formatOrderId } from "@/lib/format";
import type { Order } from "@/lib/types";

interface PrivacyProofPanelProps {
  order: Order;
}

type FetchState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "found"; record: OnChainOrderRecord }
  | { phase: "not-found" }
  | { phase: "error"; message: string };

/**
 * Observable proof of the privacy model documented in README.md's "Privacy
 * Model" section: fetches this order's *actual* on-chain ledger record,
 * live, from the indexer — right next to the order's real private fields,
 * which this component already has in memory (this app's own state) but
 * which the fetch above proves never made it to the chain. Nothing here is
 * staged or precomputed; the right column is exactly whatever
 * `getOnChainOrder` returns at click time.
 */
export function PrivacyProofPanel({ order }: PrivacyProofPanelProps) {
  const { wallet } = useWallet();
  const { network } = useNetworkContext();
  const [state, setState] = useState<FetchState>({ phase: "idle" });

  async function handleVerify() {
    if (!wallet || !network.contractAddress) return;
    setState({ phase: "loading" });
    try {
      const record = await getOnChainOrder(
        wallet.configuration,
        network.contractAddress,
        fromHex(order.id),
      );
      setState(record ? { phase: "found", record } : { phase: "not-found" });
    } catch (err) {
      setState({
        phase: "error",
        message: err instanceof Error ? err.message : "Failed to read chain state.",
      });
    }
  }

  const disabled = !wallet || !network.contractAddress || state.phase === "loading";

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: "easeOut" }}
      className="rounded-lg border border-border bg-card p-4 md:p-5"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-foreground">
          Verify privacy on-chain — {formatOrderId(order.id)}
        </p>
        <button
          onClick={handleVerify}
          disabled={disabled}
          className="flex items-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/15 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {state.phase === "loading" ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <ShieldCheck className="size-3.5" />
          )}
          {state.phase === "loading" ? "Reading live ledger…" : "Fetch live ledger record"}
        </button>
      </div>

      {state.phase === "error" && (
        <p className="mb-3 flex items-center gap-1.5 text-xs text-destructive">
          <AlertTriangle className="size-3.5 shrink-0" />
          {state.message}
        </p>
      )}
      {state.phase === "not-found" && (
        <p className="mb-3 text-xs text-muted-foreground">
          Not on the indexer yet — the wallet&rsquo;s transaction may still be
          propagating. Try again in a moment.
        </p>
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="rounded-md border border-primary/30 bg-primary/[0.04] p-3">
          <p className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-primary">
            <Eye className="size-3.5" />
            On the public ledger (fetched live)
          </p>
          {state.phase === "found" ? (
            <dl className="space-y-1 font-mono text-xs">
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">state</dt>
                <dd className="text-foreground">{state.record.state}</dd>
              </div>
              <div className="flex justify-between gap-3 break-all">
                <dt className="shrink-0 text-muted-foreground">commitment</dt>
                <dd className="text-foreground">{state.record.commitment.slice(0, 16)}…</dd>
              </div>
            </dl>
          ) : (
            <p className="text-xs text-muted-foreground/70">
              Click &ldquo;Fetch live ledger record&rdquo; to read this order
              directly from the {network.label} indexer.
            </p>
          )}
        </div>

        <div className="rounded-md border border-border bg-white/[0.02] p-3">
          <p className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            <EyeOff className="size-3.5" />
            Known only off-chain — never written to the ledger
          </p>
          <dl className="space-y-1 font-mono text-xs">
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">side</dt>
              <dd className="text-foreground">{order.side}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">price</dt>
              <dd className="text-foreground">{order.price}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">amount</dt>
              <dd className="text-foreground">{order.amount}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">expiresAt</dt>
              <dd className="text-foreground">{order.expiresAt}</dd>
            </div>
          </dl>
        </div>
      </div>

      <p className="mt-3 border-t border-border pt-2.5 text-[11px] leading-relaxed text-muted-foreground/70">
        The left column is a live read from {network.label}&rsquo;s indexer,
        not a mock — it is exactly what any network observer can see for
        this order. The right column is this app&rsquo;s own local record of
        the order you just placed. Only the <code>commitment</code> that
        binds them together (see README.md&rsquo;s Privacy Model) ever
        crossed the wire.
      </p>
    </motion.div>
  );
}
