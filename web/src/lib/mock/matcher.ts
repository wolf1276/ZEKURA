import type {
  ActivityEvent,
  ActivityKind,
  ExpiryOption,
  Order,
  OrderSide,
  OrderStatus,
} from "@/lib/types";

/**
 * In-memory stand-in for the Matcher Server's REST + WebSocket API
 * (matcher/API.md). Shapes mirror the real Order object and event stream
 * exactly, so swapping `MockMatcher` for a fetch/WebSocket-backed client
 * later touches this file only, not the components that consume it.
 */

let idCounter = 1000;
function nextId(): string {
  idCounter += 1;
  return idCounter.toString(16).padStart(4, "0").repeat(8).slice(0, 64);
}

const LIFECYCLE_DELAYS_MS = {
  toMatched: 2200,
  toSettling: 900,
  toFilled: 1600,
} as const;

type OrderListener = (orders: Order[]) => void;
type ActivityListener = (event: ActivityEvent) => void;

class MockMatcher {
  private orders: Order[] = [
    {
      id: "a821".repeat(16),
      pair: "tDUST/tUSD",
      side: "SELL",
      price: "0.86",
      amount: "60",
      status: "OPEN",
      createdAt: Date.now() - 1000 * 60 * 40,
      expiresAt: "9999999999",
      expiryLabel: "GTC",
    },
    {
      id: "a822".repeat(16),
      pair: "tDUST/tUSD",
      side: "BUY",
      price: "0.84",
      amount: "120",
      status: "MATCHED",
      createdAt: Date.now() - 1000 * 60 * 12,
      expiresAt: String(Math.floor(Date.now() / 1000) + 3600),
      expiryLabel: "1h",
    },
  ];

  private orderListeners = new Set<OrderListener>();
  private activityListeners = new Set<ActivityListener>();

  list(): Order[] {
    return this.orders;
  }

  subscribe(listener: OrderListener): () => void {
    this.orderListeners.add(listener);
    listener(this.orders);
    return () => this.orderListeners.delete(listener);
  }

  subscribeActivity(listener: ActivityListener): () => void {
    this.activityListeners.add(listener);
    return () => this.activityListeners.delete(listener);
  }

  createOrder(input: {
    pair: string;
    side: OrderSide;
    price: string;
    amount: string;
    expiryLabel: ExpiryOption;
  }): Order {
    const id = nextId();
    const expiresAt = expiryToUnixSeconds(input.expiryLabel);
    const order: Order = {
      id,
      pair: input.pair,
      side: input.side,
      price: input.price,
      amount: input.amount,
      status: "OPEN",
      createdAt: Date.now(),
      expiresAt: String(expiresAt),
      expiryLabel: input.expiryLabel,
    };
    this.orders = [order, ...this.orders];
    this.emitOrders();
    this.emitActivity("ORDER_CREATED", order);
    this.runLifecycle(id);
    return order;
  }

  cancelOrder(id: string): void {
    const order = this.orders.find((o) => o.id === id);
    if (!order || order.status !== "OPEN") return;
    this.updateStatus(id, "CANCELLED");
    this.emitActivity("ORDER_CANCELLED", order);
  }

  private runLifecycle(id: string) {
    window.setTimeout(() => {
      const order = this.orders.find((o) => o.id === id);
      if (!order || order.status !== "OPEN") return;
      this.updateStatus(id, "MATCHED");
      this.emitActivity("ORDER_MATCHED", order);

      window.setTimeout(() => {
        const o2 = this.orders.find((o) => o.id === id);
        if (!o2 || o2.status !== "MATCHED") return;
        this.updateStatus(id, "SETTLING");
        this.emitActivity("SETTLEMENT_STARTED", o2);

        window.setTimeout(() => {
          const o3 = this.orders.find((o) => o.id === id);
          if (!o3 || o3.status !== "SETTLING") return;
          this.updateStatus(id, "FILLED");
          this.emitActivity("ORDER_FILLED", o3);
        }, LIFECYCLE_DELAYS_MS.toFilled);
      }, LIFECYCLE_DELAYS_MS.toSettling);
    }, LIFECYCLE_DELAYS_MS.toMatched);
  }

  private updateStatus(id: string, status: OrderStatus) {
    this.orders = this.orders.map((o) =>
      o.id === id ? { ...o, status } : o,
    );
    this.emitOrders();
  }

  private emitOrders() {
    for (const listener of this.orderListeners) listener(this.orders);
  }

  private emitActivity(kind: ActivityKind, order: Order) {
    const event: ActivityEvent = {
      id: `${order.id}-${kind}-${Date.now()}`,
      kind,
      orderId: order.id,
      pair: order.pair,
      side: order.side,
      amount: order.amount,
      price: order.price,
      timestamp: Date.now(),
    };
    for (const listener of this.activityListeners) listener(event);
  }
}

function expiryToUnixSeconds(expiry: ExpiryOption): number {
  const now = Math.floor(Date.now() / 1000);
  switch (expiry) {
    case "10m":
      return now + 600;
    case "30m":
      return now + 1800;
    case "1h":
      return now + 3600;
    case "GTC":
      return 9999999999;
  }
}

export const mockMatcher = new MockMatcher();
