"use client";

import { AnimatePresence, motion } from "framer-motion";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Copy, X } from "lucide-react";
import { toast } from "sonner";
import type { ConnectedWalletInfo } from "./walletTypes";
import { networkLabel } from "./walletTypes";

interface WalletAddressesModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  wallet: ConnectedWalletInfo;
}

function AddressRow({ label, value }: { label: string; value: string }) {
  async function copy() {
    await navigator.clipboard.writeText(value);
    toast.success(`${label} copied`);
  }

  return (
    <div className="rounded-xl border border-border bg-white/[0.02] p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="mt-1 flex items-center gap-2">
        <p className="min-w-0 flex-1 truncate font-mono text-sm text-foreground">{value}</p>
        <button
          type="button"
          onClick={copy}
          aria-label={`Copy ${label}`}
          className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Copy className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

/**
 * Only shielded and unshielded addresses are shown — the Midnight DApp
 * Connector's `ConnectedAPI` has no notion of a "Cardano address" (that's a
 * different wallet standard entirely; see the wallet-standard mismatch this
 * refactor resolved).
 */
export function WalletAddressesModal({ open, onOpenChange, wallet }: WalletAddressesModalProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <DialogPrimitive.Portal forceMount>
            <DialogPrimitive.Overlay asChild forceMount>
              <motion.div
                className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
              />
            </DialogPrimitive.Overlay>
            <DialogPrimitive.Content asChild forceMount>
              <motion.div
                className="fixed left-1/2 top-1/2 z-50 w-[min(420px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 focus:outline-none"
                initial={{ opacity: 0, scale: 0.95, y: 8 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 8 }}
                transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
              >
                <div className="relative">
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute -inset-6 -z-10 rounded-[2rem] bg-primary/20 blur-3xl"
                  />
                  <div className="rounded-2xl border border-border bg-card p-5 shadow-2xl ring-1 ring-primary/10">
                    <div className="mb-4 flex items-start justify-between gap-4">
                      <div>
                        <DialogPrimitive.Title className="text-lg font-semibold text-foreground">
                          Wallet Addresses
                        </DialogPrimitive.Title>
                        <DialogPrimitive.Description className="mt-1 text-sm text-muted-foreground">
                          {wallet.walletName} · {networkLabel(wallet.networkId)}
                        </DialogPrimitive.Description>
                      </div>
                      <DialogPrimitive.Close
                        aria-label="Close"
                        className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <X className="size-4" />
                      </DialogPrimitive.Close>
                    </div>

                    <div className="flex flex-col gap-2.5">
                      <AddressRow label="Shielded Address" value={wallet.shieldedAddress} />
                      <AddressRow label="Unshielded Address" value={wallet.unshieldedAddress} />
                    </div>
                  </div>
                </div>
              </motion.div>
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        )}
      </AnimatePresence>
    </DialogPrimitive.Root>
  );
}
