/**
 * Local, per-browser-profile record of {orderId -> {details, blinding}} for
 * every order this profile has created — the missing piece that lets a
 * wallet later reconstruct the orderDetails/orderBlinding witnesses
 * cancelOrder and settleWithProtocol require (both re-derive and verify the
 * order's on-chain commitment; there is no way to satisfy that circuit-side
 * check without the original private inputs). Same storage pattern as
 * services/midnight/ownerSecret.ts (localStorage, generated/persisted once
 * per browser profile) — this is the "known limitation" that plan flagged
 * and never landed; this file is what actually closes it.
 *
 * Not sensitive the way ownerSecret.ts's secret is: `details`/`blinding`
 * are exactly what the wallet already discloses to the Matcher over HTTP at
 * order-creation time (see hooks/use-submit-order.ts's `submitOrder` call),
 * so persisting them locally reveals nothing that isn't already off-chain
 * with the Matcher.
 */
import { fromHex, toHex } from "@midnight-ntwrk/midnight-js-utils";
import type { OrderDetailsValue } from "@/services/midnight/commitment";

const STORAGE_KEY = "zekura:order-store";

interface StoredOrder {
  details: {
    asset: string;
    isBuy: boolean;
    price: string;
    amount: string;
    ownerBytes: string;
    expiresAt: string;
  };
  blinding: string;
}

function readAll(): Record<string, StoredOrder> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, StoredOrder>) : {};
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, StoredOrder>): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
}

/** Called once an order this profile created is confirmed live, so cancelOrder/settleWithProtocol can later reconstruct its witnesses. */
export function saveOrderWitnessData(orderId: Uint8Array, details: OrderDetailsValue, blinding: Uint8Array): void {
  const all = readAll();
  all[toHex(orderId)] = {
    details: {
      asset: toHex(details.asset),
      isBuy: details.isBuy,
      price: details.price.toString(),
      amount: details.amount.toString(),
      ownerBytes: toHex(details.owner.bytes),
      expiresAt: details.expiresAt.toString(),
    },
    blinding: toHex(blinding),
  };
  writeAll(all);
}

export function getOrderWitnessData(orderId: Uint8Array): { details: OrderDetailsValue; blinding: Uint8Array } | null {
  const entry = readAll()[toHex(orderId)];
  if (!entry) return null;
  return {
    details: {
      asset: fromHex(entry.details.asset),
      isBuy: entry.details.isBuy,
      price: BigInt(entry.details.price),
      amount: BigInt(entry.details.amount),
      owner: { bytes: fromHex(entry.details.ownerBytes) },
      expiresAt: BigInt(entry.details.expiresAt),
    },
    blinding: fromHex(entry.blinding),
  };
}

/** Dropped once an order reaches a terminal state (FILLED/CANCELLED/EXPIRED) — nothing will ever need to re-prove its witnesses again. */
export function forgetOrderWitnessData(orderId: Uint8Array): void {
  const all = readAll();
  delete all[toHex(orderId)];
  writeAll(all);
}
