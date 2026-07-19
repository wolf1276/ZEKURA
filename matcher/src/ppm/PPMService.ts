import { randomBytes, randomUUID } from 'node:crypto';

import type { ReservationRepository } from '../db/repositories/ReservationRepository.js';
import type { TreasuryRepository } from '../db/repositories/TreasuryRepository.js';
import { MarketDataService } from '../services/MarketDataService.js';
import type { Order } from '../types/Order.js';
import type { Hex32 } from '../types/Asset.js';
import type { Logger } from '../utils/logger.js';
import type { Side } from '../types/Side.js';
import type { PpmReservation } from '../types/Treasury.js';
import type { Broadcaster } from '../websocket/SocketServer.js';
import type { PricingEngine } from './PricingEngine.js';
import { NIGHT_ASSET_KEY, type TreasuryClient } from './TreasuryClient.js';

export interface PPMServiceDeps {
  readonly marketDataService: MarketDataService;
  readonly pricingEngine: PricingEngine;
  readonly treasuryClient: TreasuryClient;
  readonly reservationRepo: ReservationRepository;
  readonly treasuryRepo: TreasuryRepository;
  readonly broadcaster: Broadcaster;
  readonly logger: Logger;
  readonly statsWindowMs: number;
  readonly now?: () => number;
}

/**
 * A PPM quote that was reserved on-chain but NOT yet settled. Settlement is
 * now the responsibility of the filled order's OWN wallet (both BUY and SELL
 * — see contracts/exchange.compact's settleWithProtocol NIGHT payment leg):
 * the Matcher's operator wallet can no longer submit settleWithProtocol,
 * because receiveUnshielded always pulls funds (the buyer's NIGHT on a BUY,
 * the seller's asset on a SELL) from whoever SUBMITS the transaction. So
 * attemptFill quotes + reserves, then returns this pending outcome for the
 * user's wallet to finalize; OrderService reconciles the result lazily off
 * the chain afterward.
 */
export type PpmFillOutcome =
  | {
      readonly pending: true;
      readonly quoteId: Hex32;
      readonly assetKey: Hex32;
      readonly side: Side;
      readonly price: bigint;
      readonly amount: bigint;
      readonly expiresAt: bigint;
    }
  | { readonly pending: false; readonly reason: string };

/**
 * Orchestrates one PPM-backed fill attempt for a resting order that found no
 * user counterparty: quote -> reserve, both real on-chain reads/transactions
 * via TreasuryClient. It stops at the reservation and hands back a pending
 * quote — it NEVER submits settleWithProtocol itself (that now requires the
 * user's own wallet as submitter; see PpmFillOutcome above). Any failure
 * before the reservation (no quote, non-crossing price, insufficient
 * asset/NIGHT liquidity, a failed reserve transaction) leaves the order
 * untouched for the caller (OrderService) to treat exactly like "no match
 * found".
 */
export class PPMService {
  private readonly marketDataService: MarketDataService;
  private readonly pricingEngine: PricingEngine;
  private readonly treasuryClient: TreasuryClient;
  private readonly reservationRepo: ReservationRepository;
  private readonly treasuryRepo: TreasuryRepository;
  private readonly broadcaster: Broadcaster;
  private readonly logger: Logger;
  private readonly statsWindowMs: number;
  private readonly now: () => number;

  constructor(deps: PPMServiceDeps) {
    this.marketDataService = deps.marketDataService;
    this.pricingEngine = deps.pricingEngine;
    this.treasuryClient = deps.treasuryClient;
    this.reservationRepo = deps.reservationRepo;
    this.treasuryRepo = deps.treasuryRepo;
    this.broadcaster = deps.broadcaster;
    this.logger = deps.logger;
    this.statsWindowMs = deps.statsWindowMs;
    this.now = deps.now ?? (() => Date.now());
  }

  private nowSeconds(): bigint {
    return BigInt(Math.floor(this.now() / 1000));
  }

  private recordTreasuryEvent(kind: 'RESERVE' | 'RELEASE' | 'EXECUTE', assetKey: Hex32, amount: bigint, actor: Hex32, txId: string | null): void {
    this.treasuryRepo.insert({
      id: randomUUID(),
      kind,
      assetKey,
      amount,
      actor,
      txId,
      createdAt: this.now(),
    });
  }

  /**
   * Attempts to fill `order` entirely out of protocol liquidity. Called from
   * OrderService's no-match branch (see services/OrderService.ts) — the
   * order must still be OPEN and un-claimed when this resolves; the caller
   * owns applying the resulting state transition, exactly like it already
   * owns applying a MatchingEngine result.
   */
  async attemptFill(order: Pick<Order, 'id' | 'asset' | 'side' | 'price' | 'amount' | 'payoutAddress'>): Promise<PpmFillOutcome> {
    // order.asset *is* the Treasury's on-chain assetKey now (see types/Asset.ts).
    const onChainAssetKey = order.asset;
    const snapshot = await this.marketDataService.getSnapshot(order.asset, this.statsWindowMs);
    const referencePrice = MarketDataService.referencePrice(snapshot);
    const nowSeconds = this.nowSeconds();

    const quote = this.pricingEngine.quote(
      { side: order.side, amount: order.amount, referencePrice },
      snapshot.treasury,
      nowSeconds,
    );
    if (!quote) {
      return { pending: false, reason: 'Protocol liquidity unavailable.' };
    }

    const crosses = order.side === 'BUY' ? order.price >= quote.price : order.price <= quote.price;
    if (!crosses) {
      return { pending: false, reason: "Order's limit price does not cross the protocol's quote" };
    }

    // SELL fills: the protocol BUYS the asset and pays the seller in NIGHT
    // (settleWithProtocol's sell branch: sendUnshielded(nativeToken(), ...)).
    // Only quote it if the Treasury actually holds enough NIGHT to cover the
    // payment — same "never invent liquidity" rule the asset-side check
    // enforces, applied to the NIGHT leg. paymentAmount = amount * price.
    if (order.side === 'SELL') {
      const paymentAmount = quote.amount * quote.price;
      const nightLiquidity = await this.treasuryClient.getLiquidity(NIGHT_ASSET_KEY);
      if (nightLiquidity.available < paymentAmount) {
        return { pending: false, reason: 'Insufficient protocol NIGHT liquidity to pay the seller.' };
      }
    }

    const quoteId = randomBytes(32).toString('hex') as Hex32;
    const reserveResult = await this.treasuryClient.reserveLiquidity(
      quoteId,
      onChainAssetKey,
      quote.amount,
      quote.price,
      quote.expiresAt,
    );
    if (reserveResult.outcome !== 'success') {
      return { pending: false, reason: reserveResult.message };
    }

    const createdAt = this.now();
    this.reservationRepo.insert({
      quoteId,
      orderId: order.id,
      assetKey: onChainAssetKey,
      amount: quote.amount,
      price: quote.price,
      expiresAt: quote.expiresAt,
      state: 'OPEN',
      createdAt,
      updatedAt: createdAt,
    });
    this.recordTreasuryEvent('RESERVE', onChainAssetKey, quote.amount, quoteId, reserveResult.txId);
    this.broadcaster.broadcast('treasury.reserved', {
      quoteId,
      assetKey: onChainAssetKey,
      amount: quote.amount.toString(),
      price: quote.price.toString(),
      expiresAt: quote.expiresAt.toString(),
    });

    // Stop here: the liquidity is reserved but NOT settled. The user's own
    // wallet must submit settleWithProtocol (it supplies the NIGHT on a BUY
    // or the asset on a SELL). OrderService returns this quote to the
    // submitting session and lazily reconciles the eventual on-chain fill.
    return {
      pending: true,
      quoteId,
      assetKey: onChainAssetKey,
      side: order.side,
      price: quote.price,
      amount: quote.amount,
      expiresAt: quote.expiresAt,
    };
  }

  /**
   * Marks a reservation EXECUTED locally and records the EXECUTE Treasury
   * history row — called by OrderService's lazy reconciliation once it has
   * confirmed (directly from the chain) that the user's own
   * settleWithProtocol transaction actually landed. Idempotent: a
   * double-reconciliation is a no-op (the CAS from OPEN only fires once).
   * Returns the reservation if it existed, whether or not this call was the
   * one that transitioned it.
   */
  markReservationExecuted(quoteId: Hex32, txId: string | null = null): PpmReservation | undefined {
    const reservation = this.reservationRepo.findById(quoteId);
    if (!reservation) return undefined;
    const applied = this.reservationRepo.updateState(quoteId, 'EXECUTED', ['OPEN']);
    if (!applied) return this.reservationRepo.findById(quoteId);
    this.recordTreasuryEvent('EXECUTE', reservation.assetKey, reservation.amount, quoteId, txId);
    return { ...reservation, state: 'EXECUTED' };
  }

  /**
   * Reclaims any OPEN reservation past its expiresAt back to available
   * liquidity — the proactive half of expiry handling; releaseExpiredLiquidity
   * itself is also permissionless on-chain (see contracts/exchange.compact),
   * so this is defense in depth, not the only path a stuck reservation can
   * be recovered through. Call periodically (see src/index.ts).
   */
  async sweepExpiredReservations(): Promise<number> {
    const expired = this.reservationRepo.listExpiredOpen(this.nowSeconds());
    let released = 0;
    for (const reservation of expired) {
      const result = await this.treasuryClient.releaseExpiredLiquidity(reservation.quoteId);
      if (result.outcome === 'success') {
        this.reservationRepo.updateState(reservation.quoteId, 'RELEASED', ['OPEN']);
        this.recordTreasuryEvent('RELEASE', reservation.assetKey, reservation.amount, reservation.quoteId, result.txId);
        this.broadcaster.broadcast('treasury.released', {
          quoteId: reservation.quoteId,
          assetKey: reservation.assetKey,
          amount: reservation.amount.toString(),
        });
        released++;
      } else {
        this.logger.warn({ quoteId: reservation.quoteId, result }, 'releaseExpiredLiquidity sweep attempt did not succeed — will retry next sweep');
      }
    }
    return released;
  }
}
