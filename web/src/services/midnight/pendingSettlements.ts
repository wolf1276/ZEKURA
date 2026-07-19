/**
 * Local, per-browser-profile record of PPM quotes reserved against this
 * profile's own OPEN orders, awaiting this wallet's own settleWithProtocol
 * approval — the "Approve Settlement" step (see
 * contracts/exchange.compact's settleWithProtocol doc comment:
 * receiveUnshielded always draws from whoever submits, so only the order's
 * own owner's wallet can finish a protocol-liquidity fill; the Matcher can
 * no longer auto-execute this the way it once did for BUY).
 *
 * Populated two ways: synchronously from submitOrder's own response
 * (hooks/use-submit-order.ts, the common case — the submitting session
 * always gets pendingProtocolQuote back immediately), or from a later
 * `order.ppm_quote_ready` WS broadcast if this profile still owns the order
 * (services/matcher/matcherClient.ts — covers a second tab, or a resting
 * order that only later got PPM-filled after this session started). Same
 * storage pattern as services/midnight/orderStore.ts.
 */
const STORAGE_KEY = "zekura:pending-settlements";

export interface PendingSettlement {
  orderId: string;
  quoteId: string;
  side: "BUY" | "SELL";
  price: string;
  amount: string;
  /** Unix seconds — the Treasury reservation's own expiry (blockTimeGte on-chain), after which anyone can reclaim the liquidity and this quote is dead. */
  expiresAt: string;
}

type Listener = (all: PendingSettlement[]) => void;
const listeners = new Set<Listener>();

function readAll(): Record<string, PendingSettlement> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, PendingSettlement>) : {};
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, PendingSettlement>): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  const list = Object.values(all);
  for (const listener of listeners) listener(list);
}

export function savePendingSettlement(entry: PendingSettlement): void {
  const all = readAll();
  all[entry.orderId] = entry;
  writeAll(all);
}

export function forgetPendingSettlement(orderId: string): void {
  const all = readAll();
  delete all[orderId];
  writeAll(all);
}

export function listPendingSettlements(): PendingSettlement[] {
  return Object.values(readAll());
}

export function subscribePendingSettlements(listener: Listener): () => void {
  listeners.add(listener);
  listener(listPendingSettlements());
  return () => listeners.delete(listener);
}
