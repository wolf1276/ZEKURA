/**
 * Real Matcher-backed replacement for the old `lib/mock/matcher.ts`
 * MockMatcher — deliberately kept to the exact same public shape
 * (`subscribe`, `subscribeActivity`, `cancelOrder`) so the components that
 * already consume it (trade-page.tsx, order-status-timeline.tsx) don't need
 * to be redesigned, only re-pointed at this module.
 *
 * Reads come from the Matcher's real REST API (matcher/API.md) via the
 * same-origin proxy routes in services/matcher/api.ts, and stay live via a
 * direct WebSocket connection to the Matcher's `/ws` (not proxied — WS
 * connections aren't subject to the CORS restriction that requires proxying
 * the REST calls).
 */
import { fromHex } from "@midnight-ntwrk/midnight-js-utils";
import { ASSET_PAIRS } from "@/lib/mock/market";
import type { ActivityEvent, ActivityKind, Order, OrderStatus } from "@/lib/types";
import type { MatcherAsset, MatcherOrder, MatcherTreasuryEvent, MatcherWsMessage } from "@/types/matcher";
import { getOrderWitnessData } from "@/services/midnight/orderStore";
import { savePendingSettlement } from "@/services/midnight/pendingSettlements";
import * as api from "./api";
import { MatcherApiError } from "./api";

const TREASURY_HISTORY_KIND_TO_ACTIVITY: Record<MatcherTreasuryEvent["kind"], ActivityKind> = {
  DEPOSIT: "TREASURY_DEPOSITED",
  WITHDRAW: "TREASURY_WITHDRAWN",
  RESERVE: "TREASURY_RESERVED",
  RELEASE: "TREASURY_RELEASED",
  EXECUTE: "TREASURY_EXECUTED",
};

/** Reconstructs Treasury/PPM Activity rows from the Matcher's persisted `/treasury/history` — the only durable, replayable source for those events, since the live WS feed alone goes blank on every page reload. Order-lifecycle activity has no equivalent persisted feed yet (see matcher/src/api/*.ts) and stays live-only. */
export function treasuryEventToActivity(e: MatcherTreasuryEvent): ActivityEvent {
  return {
    id: `treasury-history-${e.id}`,
    kind: TREASURY_HISTORY_KIND_TO_ACTIVITY[e.kind],
    pair: "tNIGHT",
    amount: e.amount,
    txId: e.txId,
    timestamp: e.createdAt,
  };
}

export async function fetchTreasuryActivityBackfill(limit = 50): Promise<ActivityEvent[]> {
  try {
    const { events } = await api.getTreasuryHistory(limit);
    return events.map(treasuryEventToActivity).sort((a, b) => b.timestamp - a.timestamp);
  } catch {
    // Same non-fatal treatment as refreshOpenOrders below — live events still arrive via WS.
    return [];
  }
}

const WS_URL = process.env.NEXT_PUBLIC_MATCHER_WS_URL?.trim() || "ws://localhost:4000/ws";
const RECONNECT_DELAY_MS = 3000;
/** Safety net alongside the WS feed — same pattern/cadence as use-treasury.ts's own polling fallback, in case a WS message is missed during a reconnect or the socket never connects at all. */
const POLL_FALLBACK_MS = 30_000;

/**
 * The Matcher only knows asset IDs, not this app's display symbols — resolve
 * back via lib/mock/market.ts. The contract's asset field only ever names
 * the traded (non-NIGHT) asset, so this matches against each pair's own
 * quoteAssetId (see hooks/use-submit-order.ts's OrderDetails.asset doc
 * comment).
 */
function pairLabelFor(asset: MatcherAsset): string {
  const known = ASSET_PAIRS.find((p) => p.quoteAssetId === asset);
  return known ? `${known.base}/${known.quote}` : asset;
}

function toOrder(o: MatcherOrder): Order {
  return {
    id: o.id,
    pair: pairLabelFor(o.asset),
    side: o.side,
    price: o.price,
    amount: o.amount,
    status: o.status as OrderStatus,
    createdAt: o.createdAt,
    expiresAt: o.expiresAt,
    // The Matcher doesn't echo back a UI-facing expiry label — display code
    // (formatExpiry) derives the label from expiresAt directly, so this is
    // never read for real orders.
    expiryLabel: "GTC",
    ownerId: o.ownerId,
  };
}

const WS_KIND_TO_ACTIVITY: Partial<Record<MatcherWsMessage["type"], ActivityKind>> = {
  "order.created": "ORDER_CREATED",
  "order.matched": "ORDER_MATCHED",
  "order.settling": "SETTLEMENT_STARTED",
  "order.filled": "ORDER_FILLED",
  "order.cancelled": "ORDER_CANCELLED",
  "order.expired": "ORDER_EXPIRED",
  "order.failed": "ORDER_FAILED",
  "treasury.deposited": "TREASURY_DEPOSITED",
  "treasury.withdrawn": "TREASURY_WITHDRAWN",
  "treasury.reserved": "TREASURY_RESERVED",
  "treasury.released": "TREASURY_RELEASED",
};

type OrderListener = (orders: Order[]) => void;
type ActivityListener = (event: ActivityEvent) => void;
type MessageListener = (message: MatcherWsMessage) => void;

class MatcherClient {
  private orders = new Map<string, Order>();
  private orderListeners = new Set<OrderListener>();
  private activityListeners = new Set<ActivityListener>();
  private messageListeners = new Set<MessageListener>();
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private ready = false;

  list(): Order[] {
    return Array.from(this.orders.values());
  }

  /** False until the initial open-orders snapshot has resolved (success or failure) — lets consumers distinguish "still loading" from "genuinely no orders." */
  isReady(): boolean {
    return this.ready;
  }

  subscribe(listener: OrderListener): () => void {
    this.ensureStarted();
    this.orderListeners.add(listener);
    listener(this.list());
    return () => this.orderListeners.delete(listener);
  }

  subscribeActivity(listener: ActivityListener): () => void {
    this.ensureStarted();
    this.activityListeners.add(listener);
    return () => this.activityListeners.delete(listener);
  }

  /** Raw WS messages, for consumers that need more than the order-list projection this class otherwise exposes — e.g. hooks/use-market-data.ts, which needs order.matched's price/amount for a live trade tape. */
  subscribeMessages(listener: MessageListener): () => void {
    this.ensureStarted();
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  async cancelOrder(id: string): Promise<void> {
    try {
      const { order } = await api.cancelOrder(id);
      this.upsertOrder(toOrder(order));
    } catch (err) {
      // A 404/409 here just means another tab or the lifecycle already
      // moved the order past OPEN — nothing for the UI to recover from.
      if (!(err instanceof MatcherApiError)) throw err;
    }
  }

  private ensureStarted() {
    if (this.started || typeof window === "undefined") return;
    this.started = true;
    void this.refreshOpenOrders();
    this.connectSocket();
    window.setInterval(() => void this.refreshOpenOrders(), POLL_FALLBACK_MS);
  }

  private async refreshOpenOrders() {
    try {
      const { orders } = await api.listOpenOrders();
      for (const o of orders) this.upsertOrder(toOrder(o), { emit: false });
    } catch {
      // The live WS feed will still populate orders as events arrive; an
      // initial-list fetch failure (e.g. Matcher briefly unreachable) isn't
      // fatal.
    } finally {
      this.ready = true;
      this.emitOrders();
    }
  }

  private connectSocket() {
    if (typeof window === "undefined") return;
    const ws = new WebSocket(WS_URL);
    this.ws = ws;

    ws.addEventListener("message", (event) => {
      let message: MatcherWsMessage;
      try {
        message = JSON.parse(event.data as string);
      } catch {
        return;
      }
      this.handleMessage(message);
    });

    const scheduleReconnect = () => {
      if (this.reconnectTimer) return;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connectSocket();
      }, RECONNECT_DELAY_MS);
    };
    ws.addEventListener("close", scheduleReconnect);
    ws.addEventListener("error", () => ws.close());
  }

  private handleMessage(message: MatcherWsMessage) {
    for (const listener of this.messageListeners) listener(message);

    switch (message.type) {
      case "order.created":
      case "order.cancelled":
      case "order.expired":
        this.upsertOrder(toOrder(message.payload));
        break;
      case "order.matched":
        this.markStatus(message.payload.buyOrderId, "MATCHED");
        this.markStatus(message.payload.sellOrderId, "MATCHED");
        break;
      case "order.settling":
        this.markStatus(message.payload.match.buyOrderId, "SETTLING");
        this.markStatus(message.payload.match.sellOrderId, "SETTLING");
        break;
      case "order.filled":
        if ("order" in message.payload) {
          // Protocol-liquidity fill — a single order, not a buy/sell pair.
          this.upsertOrder(toOrder(message.payload.order));
        } else {
          this.markStatus(message.payload.match.buyOrderId, "FILLED");
          this.markStatus(message.payload.match.sellOrderId, "FILLED");
        }
        break;
      case "order.failed":
        this.markStatus(message.payload.match.buyOrderId, "FAILED");
        this.markStatus(message.payload.match.sellOrderId, "FAILED");
        break;
      case "order.ppm_quote_ready": {
        // Only surface the "Approve Settlement" step for orders this profile
        // actually owns (holds the real committed details/blinding for) —
        // e.g. another wallet's order that happened to get PPM-filled is not
        // something this session can or should act on.
        const { orderId, quoteId, side, price, amount, expiresAt } = message.payload;
        if (getOrderWitnessData(fromHex(orderId))) {
          savePendingSettlement({ orderId, quoteId, side, price, amount, expiresAt });
        }
        break;
      }
    }

    this.emitActivityForMessage(message, WS_KIND_TO_ACTIVITY[message.type]);
  }

  private emitActivityForMessage(
    message: MatcherWsMessage,
    kind: ActivityKind | undefined,
  ) {
    if (!kind) return;
    switch (message.type) {
      case "order.matched":
      case "order.settling":
      case "order.failed": {
        const match = "match" in message.payload ? message.payload.match : message.payload;
        this.emitActivity(kind, match.buyOrderId, match.asset, match.price, match.amount);
        this.emitActivity(kind, match.sellOrderId, match.asset, match.price, match.amount);
        return;
      }
      case "order.filled": {
        if ("order" in message.payload) {
          const { order, price, amount } = message.payload;
          this.emitActivity(kind, order.id, order.asset, price, amount);
          return;
        }
        const match = message.payload.match;
        this.emitActivity(kind, match.buyOrderId, match.asset, match.price, match.amount);
        this.emitActivity(kind, match.sellOrderId, match.asset, match.price, match.amount);
        return;
      }
      case "order.created":
      case "order.cancelled":
      case "order.expired": {
        const order = message.payload;
        this.emitActivity(kind, order.id, order.asset, order.price, order.amount);
        return;
      }
      case "treasury.deposited":
      case "treasury.withdrawn": {
        const { amount, txId } = message.payload;
        this.emitTreasuryActivity(kind, amount, txId);
        return;
      }
      case "treasury.reserved":
      case "treasury.released": {
        const { amount } = message.payload;
        this.emitTreasuryActivity(kind, amount, null);
        return;
      }
      default:
        return;
    }
  }

  private markStatus(orderId: string, status: OrderStatus) {
    const existing = this.orders.get(orderId);
    if (!existing) return;
    this.upsertOrder({ ...existing, status });
  }

  private upsertOrder(order: Order, options: { emit?: boolean } = {}) {
    this.orders.set(order.id, order);
    if (options.emit !== false) this.emitOrders();
  }

  private emitOrders() {
    const list = this.list();
    for (const listener of this.orderListeners) listener(list);
  }

  private emitActivity(
    kind: ActivityKind,
    orderId: string,
    asset: MatcherAsset,
    price: string,
    amount: string,
  ) {
    const order = this.orders.get(orderId);
    const event: ActivityEvent = {
      id: `${orderId}-${kind}-${Date.now()}`,
      kind,
      orderId,
      pair: order?.pair ?? pairLabelFor(asset),
      side: order?.side ?? "BUY",
      amount,
      price,
      timestamp: Date.now(),
    };
    for (const listener of this.activityListeners) listener(event);
  }

  /** Treasury/PPM events have no orderId/pair/side — the demo Treasury only ever moves tNIGHT (see components/treasury/treasury-page.tsx), so that's hardcoded as the display symbol here rather than resolving assetKey generically. */
  private emitTreasuryActivity(kind: ActivityKind, amount: string, txId: string | null) {
    const event: ActivityEvent = {
      id: `treasury-${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind,
      pair: "tNIGHT",
      amount,
      txId,
      timestamp: Date.now(),
    };
    for (const listener of this.activityListeners) listener(event);
  }
}

export const matcher = new MatcherClient();
