import type { BootstrapPriceRepository } from '../db/repositories/BootstrapPriceRepository.js';
import type { MatchRepository } from '../db/repositories/MatchRepository.js';
import type { OrderRepository } from '../db/repositories/OrderRepository.js';
import type { ReservationRepository } from '../db/repositories/ReservationRepository.js';
import type { Match } from '../matcher/Match.js';
import type { MatchingEngine } from '../matcher/MatchingEngine.js';
import type { OrderBook } from '../orderbook/OrderBook.js';
import { buildOrderBookSnapshot, type OrderBookSnapshot } from '../orderbook/snapshot.js';
import type { PPMService } from '../ppm/PPMService.js';
import type { OnChainReservationReader } from '../ppm/TreasuryClient.js';
import type { OnChainOrderReader } from '../settlement/SettlementClient.js';
import { assetKey, type Asset, type Hex32 } from '../types/Asset.js';
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

/**
 * A fill against protocol liquidity instead of a second user order. Retained
 * in the result shape for backward compatibility, but always null now: the
 * Matcher no longer auto-executes a protocol fill (settleWithProtocol must be
 * submitted by the user's own wallet — see PendingProtocolQuote and
 * contracts/exchange.compact's NIGHT payment leg). A completed protocol fill
 * surfaces via the order.filled WS broadcast reconciliation emits, not here.
 */
export interface ProtocolFill {
  readonly quoteId: Hex32;
  readonly price: bigint;
  readonly amount: bigint;
  readonly txId: string;
}

/**
 * A protocol-liquidity quote that has been reserved on-chain but still needs
 * the user's own wallet to submit settleWithProtocol. Included directly in
 * the POST /orders response so the submitting session can offer an "Approve
 * Settlement" step without waiting for a WS round-trip; other sessions learn
 * of it via the order.ppm_quote_ready broadcast instead.
 */
export interface PendingProtocolQuote {
  readonly quoteId: Hex32;
  readonly price: bigint;
  readonly amount: bigint;
  readonly expiresAt: bigint;
}

export type SubmitOrderResult =
  | {
      readonly ok: true;
      readonly order: Order;
      readonly match: Match | null;
      readonly protocolFill: ProtocolFill | null;
      readonly pendingProtocolQuote: PendingProtocolQuote | null;
    }
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
  /** Optional: when absent, an order that finds no user counterparty simply rests OPEN, same as before the Treasury/PPM existed. */
  readonly ppmService?: PPMService;
  /** Optional: local mirror of PPM reservations — needed for lazy reconciliation of a pending protocol fill. Present whenever ppmService is. */
  readonly reservationRepo?: ReservationRepository;
  /** Optional: free on-chain read of a reservation's state — the authoritative signal that a user-submitted settleWithProtocol landed. */
  readonly reservationReader?: OnChainReservationReader;
  /** Optional: retires an asset's bootstrap price the moment it has a real match — absent only in tests that don't exercise bootstrap pricing. */
  readonly bootstrapPriceRepo?: BootstrapPriceRepository;
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
  private readonly ppmService: PPMService | undefined;
  private readonly reservationRepo: ReservationRepository | undefined;
  private readonly reservationReader: OnChainReservationReader | undefined;
  private readonly bootstrapPriceRepo: BootstrapPriceRepository | undefined;
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
    this.ppmService = deps.ppmService;
    this.reservationRepo = deps.reservationRepo;
    this.reservationReader = deps.reservationReader;
    this.bootstrapPriceRepo = deps.bootstrapPriceRepo;
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
      // No user counterparty — offer it to the PPM before it rests, exactly
      // matching priority 2/3 from the spec (user orders first, protocol
      // liquidity only as a fallback). Any failure here (no PPM configured,
      // no quote, insufficient liquidity, a failed reserve/settle
      // transaction) is treated identically to "no match found": the order
      // simply rests OPEN. See ppm/PPMService.ts's own doc comment.
      if (this.ppmService) {
        const ppmResult = await this.ppmService.attemptFill(order);
        if (ppmResult.pending) {
          // The PPM reserved liquidity but did NOT settle — the order stays
          // OPEN locally until the user's own wallet submits
          // settleWithProtocol and reconciliation confirms it on-chain.
          // Broadcast so other sessions (a second tab, the Orders page) can
          // surface the "Approve Settlement" step; the submitting session
          // gets it synchronously in this same HTTP response too.
          this.broadcaster.broadcast('order.ppm_quote_ready', {
            orderId: order.id,
            quoteId: ppmResult.quoteId,
            assetKey: ppmResult.assetKey,
            side: ppmResult.side,
            amount: ppmResult.amount.toString(),
            price: ppmResult.price.toString(),
            expiresAt: ppmResult.expiresAt.toString(),
          });

          return {
            ok: true,
            order,
            match: null,
            protocolFill: null,
            pendingProtocolQuote: {
              quoteId: ppmResult.quoteId,
              price: ppmResult.price,
              amount: ppmResult.amount,
              expiresAt: ppmResult.expiresAt,
            },
          };
        }
      }
      return { ok: true, order, match: null, protocolFill: null, pendingProtocolQuote: null };
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
      return { ok: true, order, match: null, protocolFill: null, pendingProtocolQuote: null };
    }

    this.orderBook.remove(match.buyOrderId);
    this.orderBook.remove(match.sellOrderId);
    // Genuine price discovery now exists for this asset — retire its
    // bootstrap price permanently (see BootstrapPriceRepository.clear).
    this.bootstrapPriceRepo?.clear(match.asset);
    this.broadcaster.broadcast('order.matched', match);
    this.onMatch(match);

    return { ok: true, order, match, protocolFill: null, pendingProtocolQuote: null };
  }

  /**
   * Lazy reconciliation of a pending protocol fill — the on-chain state is
   * always the source of truth, so there is no "trust the client's claim"
   * surface here. If an OPEN order has an OPEN PPM reservation and the chain
   * shows either the order FILLED or the reservation EXECUTED (both are set
   * atomically by settleWithProtocol), materialize the fill locally
   * (CAS OPEN -> FILLED) and emit the SAME order.filled broadcast the old
   * auto-fill path used, so downstream consumers need no changes. Idempotent:
   * a double call, or a call after the CAS already fired, is a no-op.
   */
  private async reconcileProtocolFill(order: Order): Promise<Order> {
    if (order.status !== 'OPEN' || !this.reservationRepo) return order;
    const reservation = this.reservationRepo.findOpenByOrderId(order.id);
    if (!reservation) return order;

    const onChainOrder = await this.onChainReader.getOrder(order.id);
    let settled = onChainOrder.state === 'FILLED';
    if (!settled && this.reservationReader) {
      const reservationState = await this.reservationReader.getReservationState(reservation.quoteId);
      settled = reservationState === 'EXECUTED';
    }

    if (!settled) return order;

    const applied = this.orderRepo.updateStatus(order.id, 'FILLED', ['OPEN']);
    if (!applied) {
      // Lost a race to another reconciler/cancel — re-read authoritative row.
      return this.orderRepo.findById(order.id) ?? order;
    }
    this.orderBook.remove(order.id);
    this.ppmService?.markReservationExecuted(reservation.quoteId);
    const filled: Order = { ...order, status: 'FILLED' };
    this.broadcaster.broadcast('order.filled', {
      order: filled,
      matchedWith: 'protocol',
      quoteId: reservation.quoteId,
      price: reservation.price.toString(),
      amount: reservation.amount.toString(),
      txId: null,
    });
    return filled;
  }

  /**
   * Sweeps every locally-OPEN reservation and reconciles any whose fill has
   * landed on-chain — the closed-tab safety net, called on the same periodic
   * loop as sweepExpiredReservations (see src/index.ts). Returns how many
   * orders it materialized to FILLED.
   */
  async reconcileAllPendingProtocolFills(): Promise<number> {
    if (!this.reservationRepo) return 0;
    let materialized = 0;
    for (const reservation of this.reservationRepo.listByState('OPEN')) {
      if (!reservation.orderId) continue;
      const order = this.orderRepo.findById(reservation.orderId);
      if (!order || order.status !== 'OPEN') continue;
      const result = await this.reconcileProtocolFill(order);
      if (result.status === 'FILLED') materialized++;
    }
    return materialized;
  }

  /** getOrder, but first reconciling any pending protocol fill against the chain — the read path behind GET /orders/:id, which the web settlement hook re-fetches after the wallet submits settleWithProtocol. */
  async getOrderReconciled(id: string): Promise<Order | undefined> {
    const found = this.orderRepo.findById(id);
    if (!found) return undefined;
    const order = this.materializeExpiry(found);
    return this.reconcileProtocolFill(order);
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
    return this.matchRepo.listRecentByAssetKey(assetKey(asset), limit);
  }

  /** Rolling-window stats for one asset, computed on read from persisted matches — the read path behind GET /stats. See types/MarketStats.ts. */
  getMarketStats(asset: Asset, windowMs: number): MarketStats {
    const trades = this.matchRepo.listSinceByAssetKey(assetKey(asset), this.now() - windowMs);
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
