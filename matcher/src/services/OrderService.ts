import type { MatchRepository } from '../db/repositories/MatchRepository.js';
import type { OrderRepository } from '../db/repositories/OrderRepository.js';
import type { Match } from '../matcher/Match.js';
import type { MatchingEngine } from '../matcher/MatchingEngine.js';
import type { OrderBook } from '../orderbook/OrderBook.js';
import { buildOrderBookSnapshot, type OrderBookSnapshot } from '../orderbook/snapshot.js';
import type { OnChainOrderReader } from '../settlement/SettlementClient.js';
import { assetKey, type Asset } from '../types/Asset.js';
import type { MarketStats } from '../types/MarketStats.js';
import { isExpired, type Order } from '../types/Order.js';
import type { CreateOrderInput } from '../utils/validation.js';
import { verifyOrderSignature } from '../utils/orderDetailsCodec.js';
import type { Logger } from '../utils/logger.js';
import type { Broadcaster } from '../websocket/SocketServer.js';
import type Database from 'better-sqlite3';

function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as { code?: string }).code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
}

export type SubmitOrderErrorCode =
  | 'DUPLICATE'
  | 'SIGNATURE_INVALID'
  | 'NOT_ON_CHAIN'
  | 'NOT_OPEN_ON_CHAIN'
  | 'COMMITMENT_MISMATCH'
  | 'EXPIRED';

export type SubmitOrderResult =
  | { readonly ok: true; readonly order: Order; readonly match: Match | null }
  | { readonly ok: false; readonly code: SubmitOrderErrorCode; readonly message: string };

export type CancelOrderErrorCode = 'NOT_FOUND' | 'NOT_CANCELLABLE';

export type CancelOrderResult =
  | { readonly ok: true; readonly order: Order }
  | { readonly ok: false; readonly code: CancelOrderErrorCode; readonly message: string };

export interface OrderServiceDeps {
  readonly db: Database.Database;
  readonly orderRepo: OrderRepository;
  readonly matchRepo: MatchRepository;
  readonly orderBook: OrderBook;
  readonly matchingEngine: MatchingEngine;
  readonly onChainReader: OnChainOrderReader;
  readonly broadcaster: Broadcaster;
  readonly logger: Logger;
  /** Called synchronously right after a match is atomically claimed — wired to SettlementService.handleMatch by src/app.ts, kept as a callback to avoid a circular OrderService<->SettlementService dependency. */
  readonly onMatch: (match: Match) => void;
  readonly now?: () => number;
}

/**
 * Owns order submission, cancellation, and reads. See ARCHITECTURE.md for
 * the full request flow; the two load-bearing invariants enforced here:
 *
 *  - A disclosed order is only ever trusted if its recomputed commitment
 *    matches BOTH the value the client sent AND the commitment already
 *    recorded on-chain for that orderId (see utils/orderDetailsCodec.ts —
 *    this recomputation IS the authentication, no separate signature
 *    scheme). An order the Matcher hasn't independently verified against
 *    the chain never enters the book.
 *  - The claim step (flipping both matched orders OPEN -> MATCHED and
 *    recording the match) runs inside one synchronous db.transaction() with
 *    no `await` in between, so no concurrent request can double-claim
 *    either order — see ARCHITECTURE.md's concurrency section.
 */
export class OrderService {
  private readonly db: Database.Database;
  private readonly orderRepo: OrderRepository;
  private readonly matchRepo: MatchRepository;
  private readonly orderBook: OrderBook;
  private readonly matchingEngine: MatchingEngine;
  private readonly onChainReader: OnChainOrderReader;
  private readonly broadcaster: Broadcaster;
  private readonly logger: Logger;
  private readonly onMatch: (match: Match) => void;
  private readonly now: () => number;

  constructor(deps: OrderServiceDeps) {
    this.db = deps.db;
    this.orderRepo = deps.orderRepo;
    this.matchRepo = deps.matchRepo;
    this.orderBook = deps.orderBook;
    this.matchingEngine = deps.matchingEngine;
    this.onChainReader = deps.onChainReader;
    this.broadcaster = deps.broadcaster;
    this.logger = deps.logger;
    this.onMatch = deps.onMatch;
    this.now = deps.now ?? (() => Date.now());
  }

  private nowSeconds(): bigint {
    return BigInt(Math.floor(this.now() / 1000));
  }

  /** Transitions an OPEN-but-past-expiry order to EXPIRED and evicts it from the book. Idempotent. Called lazily — see decision on "never poll" in ARCHITECTURE.md. */
  private materializeExpiry(order: Order): Order {
    if (order.status !== 'OPEN' || !isExpired(order, this.nowSeconds())) return order;
    const applied = this.orderRepo.updateStatus(order.id, 'EXPIRED', ['OPEN']);
    if (applied) {
      this.orderBook.remove(order.id);
      const expired: Order = { ...order, status: 'EXPIRED' };
      this.broadcaster.broadcast('order.expired', expired);
      return expired;
    }
    // Lost a race to another materializer (e.g. concurrent cancel) — re-read the authoritative row.
    return this.orderRepo.findById(order.id) ?? order;
  }

  async submitOrder(input: CreateOrderInput): Promise<SubmitOrderResult> {
    if (this.orderRepo.exists(input.id)) {
      return { ok: false, code: 'DUPLICATE', message: `Order ${input.id} has already been submitted to this Matcher` };
    }

    const draft = { ...input, status: 'OPEN' as const, createdAt: this.now() };

    if (!verifyOrderSignature(draft, input.commitment)) {
      return {
        ok: false,
        code: 'SIGNATURE_INVALID',
        message: 'Recomputed commitment does not match the supplied commitment — invalid order details, amount, price, asset, side, ownerId, or signature (blinding factor)',
      };
    }

    const onChain = await this.onChainReader.getOrder(input.id);
    if (onChain.state === 'NOT_FOUND') {
      return {
        ok: false,
        code: 'NOT_ON_CHAIN',
        message: `No order registered on-chain for id ${input.id} — submit createOrder() first and wait for it to finalize`,
      };
    }
    if (onChain.commitment !== input.commitment) {
      return {
        ok: false,
        code: 'COMMITMENT_MISMATCH',
        message: 'Supplied commitment does not match the commitment recorded on-chain for this orderId',
      };
    }
    if (onChain.state !== 'OPEN') {
      return { ok: false, code: 'NOT_OPEN_ON_CHAIN', message: `On-chain order state is ${onChain.state}, not OPEN` };
    }

    if (isExpired(draft, this.nowSeconds())) {
      return { ok: false, code: 'EXPIRED', message: 'Order expiresAt is already in the past' };
    }

    const order: Order = draft;
    try {
      this.orderRepo.insert(order);
    } catch (error) {
      // The exists() check above is only a fast-path — it happens before the
      // `await` on onChainReader.getOrder(), so two concurrent submissions
      // of the same orderId can both pass it before either has inserted.
      // The database's PRIMARY KEY constraint is the actual source of
      // truth here; translate its violation into the same DUPLICATE result
      // exists() would have produced had it won the race.
      if (isUniqueConstraintViolation(error)) {
        return { ok: false, code: 'DUPLICATE', message: `Order ${input.id} has already been submitted to this Matcher` };
      }
      throw error;
    }
    this.orderBook.add(order);
    this.broadcaster.broadcast('order.created', order);

    const lookup = (id: string): Order | undefined => {
      const found = this.orderRepo.findById(id);
      return found ? this.materializeExpiry(found) : undefined;
    };

    const match = this.matchingEngine.onOrderArrived(order, lookup, this.nowSeconds());
    if (!match) {
      return { ok: true, order, match: null };
    }

    const claimed = this.db.transaction(() => {
      const buyClaimed = this.orderRepo.updateStatus(match.buyOrderId, 'MATCHED', ['OPEN']);
      const sellClaimed = this.orderRepo.updateStatus(match.sellOrderId, 'MATCHED', ['OPEN']);
      if (!buyClaimed || !sellClaimed) return false;
      this.matchRepo.insert(match);
      return true;
    })();

    if (!claimed) {
      // Structurally shouldn't happen (Node is single-threaded and this whole
      // handler runs synchronously up to this point — see class doc comment)
      // but if it ever does, the order stays OPEN and simply waits for the
      // next arrival/removal to be reconsidered rather than being lost.
      this.logger.error({ match }, 'failed to atomically claim a match — one or both orders were no longer OPEN');
      return { ok: true, order, match: null };
    }

    this.orderBook.remove(match.buyOrderId);
    this.orderBook.remove(match.sellOrderId);
    this.broadcaster.broadcast('order.matched', match);
    this.onMatch(match);

    return { ok: true, order, match };
  }

  /**
   * Removes an order from the Matcher's own book/DB only. This can never
   * submit an on-chain cancelOrder() — the Matcher structurally cannot: it
   * is disclosed OrderDetails + blinding but never an owner's
   * ownerSecretKey (see AUDIT.md's threat model and
   * settlement/SettlementClient.ts's witness construction), and
   * cancelOrder() requires exactly that secret. The order's owner must
   * submit the real on-chain cancellation themselves.
   */
  cancelOrder(id: string): CancelOrderResult {
    const found = this.orderRepo.findById(id);
    if (!found) return { ok: false, code: 'NOT_FOUND', message: `No such order: ${id}` };

    const order = this.materializeExpiry(found);
    if (order.status !== 'OPEN') {
      return { ok: false, code: 'NOT_CANCELLABLE', message: `Order ${id} is ${order.status}, not OPEN` };
    }

    const applied = this.orderRepo.updateStatus(id, 'CANCELLED', ['OPEN']);
    if (!applied) {
      return { ok: false, code: 'NOT_CANCELLABLE', message: `Order ${id} changed state concurrently — no longer OPEN` };
    }
    this.orderBook.remove(id);
    const cancelled: Order = { ...order, status: 'CANCELLED' };
    this.broadcaster.broadcast('order.cancelled', cancelled);
    return { ok: true, order: cancelled };
  }

  getOrder(id: string): Order | undefined {
    const found = this.orderRepo.findById(id);
    return found ? this.materializeExpiry(found) : undefined;
  }

  listOpen(): Order[] {
    return this.orderRepo
      .listOpen()
      .map((order) => this.materializeExpiry(order))
      .filter((order) => order.status === 'OPEN');
  }

  /** Live orderbook snapshot for one asset — the read path behind GET /orderbook. The frontend keeps this current afterward purely from the existing order.created/cancelled/expired/matched WS broadcasts, so no separate orderbook WS message type exists. */
  getOrderBookSnapshot(asset: Asset): OrderBookSnapshot {
    const openOrders = this.orderRepo
      .listOpenByAssetKey(assetKey(asset))
      .map((order) => this.materializeExpiry(order))
      .filter((order) => order.status === 'OPEN');
    return buildOrderBookSnapshot(asset, openOrders);
  }

  /** Most recent trades (fills) for one asset, newest first — the read path behind GET /trades. Each trade is a persisted Match; the frontend's live trade tape appends to this from the existing order.matched WS broadcast. */
  listRecentTrades(asset: Asset, limit: number): Match[] {
    return this.matchRepo.listRecentByAssetKey(assetKey(asset), limit, asset);
  }

  /** Rolling-window stats for one asset, computed on read from persisted matches — the read path behind GET /stats. See types/MarketStats.ts. */
  getMarketStats(asset: Asset, windowMs: number): MarketStats {
    const trades = this.matchRepo.listSinceByAssetKey(assetKey(asset), this.now() - windowMs, asset);
    if (trades.length === 0) {
      return { asset, lastPrice: null, openPrice: null, high: null, low: null, volumeBase: 0n, tradeCount: 0, changePct: null };
    }

    let high = trades[0]!.price;
    let low = trades[0]!.price;
    let volume = 0n;
    for (const trade of trades) {
      if (trade.price > high) high = trade.price;
      if (trade.price < low) low = trade.price;
      volume += trade.amount;
    }

    const openPrice = trades[0]!.price;
    const lastPrice = trades[trades.length - 1]!.price;
    const changePct = openPrice > 0n ? (Number(lastPrice - openPrice) / Number(openPrice)) * 100 : null;

    return { asset, lastPrice, openPrice, high, low, volumeBase: volume, tradeCount: trades.length, changePct };
  }
}
