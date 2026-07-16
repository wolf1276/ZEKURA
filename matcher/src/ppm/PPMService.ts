import { randomBytes, randomUUID } from 'node:crypto';

import type { ReservationRepository } from '../db/repositories/ReservationRepository.js';
import type { TreasuryRepository } from '../db/repositories/TreasuryRepository.js';
import { MarketDataService } from '../services/MarketDataService.js';
import type { Order } from '../types/Order.js';
import type { Hex32 } from '../types/Asset.js';
import type { Logger } from '../utils/logger.js';
import type { Broadcaster } from '../websocket/SocketServer.js';
import type { PricingEngine } from './PricingEngine.js';
import { userAddressRecipient, UNUSED_RECIPIENT, type TreasuryClient } from './TreasuryClient.js';

export interface PPMServiceDeps {
  readonly marketDataService: MarketDataService;
  readonly pricingEngine: PricingEngine;
  readonly treasuryClient: TreasuryClient;
  readonly reservationRepo: ReservationRepository;
  readonly treasuryRepo: TreasuryRepository;
  readonly broadcaster: Broadcaster;
  readonly logger: Logger;
  /** deriveAssetKey(asset) — see MarketDataService's doc comment on the same mapping. */
  readonly toOnChainAssetKey: (asset: Order['asset']) => Hex32;
  readonly statsWindowMs: number;
  readonly now?: () => number;
}

export type PpmFillOutcome =
  | {
      readonly filled: true;
      readonly quoteId: Hex32;
      readonly price: bigint;
      readonly amount: bigint;
      readonly txId: string;
    }
  | { readonly filled: false; readonly reason: string };

/**
 * Orchestrates one PPM-backed fill attempt for a resting order that found no
 * user counterparty: quote -> reserve -> settle, all real on-chain
 * transactions via TreasuryClient. Never invents a fill — any failure at any
 * step (no quote, insufficient liquidity, a failed reserve/settle
 * transaction) leaves the order untouched for the caller (OrderService) to
 * treat exactly like "no match found".
 */
export class PPMService {
  private readonly marketDataService: MarketDataService;
  private readonly pricingEngine: PricingEngine;
  private readonly treasuryClient: TreasuryClient;
  private readonly reservationRepo: ReservationRepository;
  private readonly treasuryRepo: TreasuryRepository;
  private readonly broadcaster: Broadcaster;
  private readonly logger: Logger;
  private readonly toOnChainAssetKey: (asset: Order['asset']) => Hex32;
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
    this.toOnChainAssetKey = deps.toOnChainAssetKey;
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
    const onChainAssetKey = this.toOnChainAssetKey(order.asset);
    const snapshot = await this.marketDataService.getSnapshot(order.asset, this.statsWindowMs);
    const referencePrice = MarketDataService.referencePrice(snapshot);
    const nowSeconds = this.nowSeconds();

    const quote = this.pricingEngine.quote(
      { side: order.side, amount: order.amount, referencePrice },
      snapshot.treasury,
      nowSeconds,
    );
    if (!quote) {
      return { filled: false, reason: 'Protocol liquidity unavailable.' };
    }

    const crosses = order.side === 'BUY' ? order.price >= quote.price : order.price <= quote.price;
    if (!crosses) {
      return { filled: false, reason: "Order's limit price does not cross the protocol's quote" };
    }

    if (order.side === 'BUY' && !order.payoutAddress) {
      return {
        filled: false,
        reason: 'Order has no payout address on file — cannot receive a protocol-liquidity fill (see Order.payoutAddress)',
      };
    }

    const quoteId = randomBytes(32).toString('hex');
    const reserveResult = await this.treasuryClient.reserveLiquidity(
      quoteId,
      onChainAssetKey,
      quote.amount,
      quote.price,
      quote.expiresAt,
    );
    if (reserveResult.outcome !== 'success') {
      return { filled: false, reason: reserveResult.message };
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

    const recipient = order.side === 'BUY' ? userAddressRecipient(order.payoutAddress as Hex32) : UNUSED_RECIPIENT;
    const settleResult = await this.treasuryClient.settleWithProtocol(order.id, quoteId, recipient);

    if (settleResult.outcome !== 'success') {
      // Best-effort: give the liquidity back rather than leaving it
      // needlessly reserved until releaseExpiredLiquidity eventually can.
      const released = await this.treasuryClient.releaseLiquidity(quoteId);
      if (released.outcome === 'success') {
        this.reservationRepo.updateState(quoteId, 'RELEASED', ['OPEN']);
        this.recordTreasuryEvent('RELEASE', onChainAssetKey, quote.amount, quoteId, released.txId);
        this.broadcaster.broadcast('treasury.released', { quoteId, assetKey: onChainAssetKey, amount: quote.amount.toString() });
      } else {
        this.logger.warn(
          { quoteId, settleResult, released },
          'settleWithProtocol failed and the best-effort releaseLiquidity also failed — reservation stays OPEN until it expires and releaseExpiredLiquidity reclaims it',
        );
      }
      return { filled: false, reason: settleResult.message };
    }

    this.reservationRepo.updateState(quoteId, 'EXECUTED', ['OPEN']);
    this.recordTreasuryEvent('EXECUTE', onChainAssetKey, quote.amount, quoteId, settleResult.txId);

    return { filled: true, quoteId, price: quote.price, amount: quote.amount, txId: settleResult.txId };
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
