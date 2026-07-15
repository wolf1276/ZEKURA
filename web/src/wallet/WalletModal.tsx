"use client";

import { AnimatePresence, motion } from "framer-motion";
import { Dialog as DialogPrimitive } from "radix-ui";
import { X } from "lucide-react";
import { useWalletContext } from "./walletContext";
import { WalletCard } from "./WalletCard";
import { NetworkSwitcher } from "@/network/NetworkSwitcher";

export function WalletModal() {
  const { isModalOpen, closeModal, pickerWallets, connectingWalletId, connectTo, errorMessage } =
    useWalletContext();

  return (
    <DialogPrimitive.Root
      open={isModalOpen}
      onOpenChange={(open) => {
        if (!open) closeModal();
      }}
    >
      <AnimatePresence>
        {isModalOpen && (
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
                className="fixed left-1/2 top-1/2 z-50 w-[min(400px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 focus:outline-none"
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
                          Connect Wallet
                        </DialogPrimitive.Title>
                        <DialogPrimitive.Description className="mt-1 text-sm text-muted-foreground">
                          Choose a wallet to continue using Zekura.
                        </DialogPrimitive.Description>
                      </div>
                      <DialogPrimitive.Close
                        aria-label="Close"
                        className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <X className="size-4" />
                      </DialogPrimitive.Close>
                    </div>

                    <div className="mb-3 flex items-center justify-between gap-2 rounded-lg border border-border bg-white/[0.02] px-3 py-2">
                      <span className="text-xs text-muted-foreground">Connecting on</span>
                      <NetworkSwitcher />
                    </div>

                    {errorMessage && (
                      <p
                        role="alert"
                        className="mb-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
                      >
                        {errorMessage}
                      </p>
                    )}

                    <div className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto scrollbar-none">
                      {pickerWallets.map((w) => (
                        <WalletCard
                          key={w.id}
                          wallet={w}
                          connecting={connectingWalletId === w.id}
                          disabled={connectingWalletId !== null && connectingWalletId !== w.id}
                          onSelect={() => connectTo(w.id)}
                        />
                      ))}
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
