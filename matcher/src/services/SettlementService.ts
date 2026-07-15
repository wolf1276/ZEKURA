import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import type { MatchRepository } from '../db/repositories/MatchRepository.js';
import type { OrderRepository } from '../db/repositories/OrderRepository.js';
import type { Match } from '../matcher/Match.js';
import type { SettlementClient } from '../settlement/SettlementClient.js';
import type { SettlementQueue } from '../settlement/SettlementQueue.js';
import type { Logger } from '../utils/logger.js';
import type { Broadcaster } from '../websocket/SocketServer.js';

interface SettlementRow {
  id: string;
  match_id: string;
  status: 'PENDING' | 'SUCCESS' | 'FAILED';
  tx_id: string | null;
  error: string | null;
  attempts: number;
  created_at: number;
  updated_at: number;
}

export interface SettlementServiceDeps {
  readonly db: Database.Database;
  readonly orderRepo: OrderRepository;
  readonly matchRepo: MatchRepository;
  readonly settlementClient: SettlementClient;
  readonly queue: SettlementQueue;
  readonly broadcaster: Broadcaster;
  readonly logger: Logger;
  readonly now?: () => number;
}

/**
 * Drains SettlementQueue: for each match, calls SettlementClient.settle(),
 * persists the settlements row, flips both orders to their final status,
 * and broadcasts order.settling/order.filled/order.failed. See
 * ARCHITECTURE.md for the full retry/recovery policy this implements.
 */
export class SettlementService {
  private readonly db: Database.Database;
  private readonly orderRepo: OrderRepository;
  private readonly matchRepo: MatchRepository;
  private readonly settlementClient: SettlementClient;
  private readonly queue: SettlementQueue;
  private readonly broadcaster: Broadcaster;
  private readonly logger: Logger;
  private readonly now: () => number;

  constructor(deps: SettlementServiceDeps) {
    this.db = deps.db;
    this.orderRepo = deps.orderRepo;
    this.matchRepo = deps.matchRepo;
    this.settlementClient = deps.settlementClient;
    this.queue = deps.queue;
    this.broadcaster = deps.broadcaster;
    this.logger = deps.logger;
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Called once at the start of every settlement attempt (including retries
   * and post-restart recovery), incrementing the attempt counter exactly
   * once per attempt. Keyed off row existence rather than `attempt === 1`
   * so a recovered settlement (see recoverPendingSettlements — a fresh
   * SettlementQueue run that restarts its own attempt counter at 1) UPDATEs
   * the pre-existing row instead of colliding with its PRIMARY KEY.
   */
  private recordAttemptStart(matchId: string): void {
    const now = this.now();
    const existing = this.db.prepare('SELECT 1 FROM settlements WHERE match_id = ?').get(matchId);
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO settlements (id, match_id, status, tx_id, error, attempts, created_at, updated_at)
           VALUES (@id, @match_id, 'PENDING', NULL, NULL, 1, @now, @now)`,
        )
        .run({ id: randomUUID(), match_id: matchId, now });
      return;
    }
    this.db.prepare('UPDATE settlements SET attempts = attempts + 1, updated_at = @now WHERE match_id = @match_id').run({ match_id: matchId, now });
  }

  /** Records the outcome of the attempt just made — never touches `attempts` (see recordAttemptStart). */
  private recordOutcome(matchId: string, patch: Pick<SettlementRow, 'status'> & Partial<Pick<SettlementRow, 'tx_id' | 'error'>>): void {
    const now = this.now();
    this.db
      .prepare(
        `UPDATE settlements
         SET status = @status, tx_id = COALESCE(@tx_id, tx_id), error = @error, updated_at = @now
         WHERE match_id = @match_id`,
      )
      .run({ match_id: matchId, status: patch.status, tx_id: patch.tx_id ?? null, error: patch.error ?? null, now });
  }

  private markOrdersTerminal(match: Match, status: 'FILLED' | 'FAILED'): void {
    this.db.transaction(() => {
      this.orderRepo.updateStatus(match.buyOrderId, status, ['MATCHED', 'SETTLING']);
      this.orderRepo.updateStatus(match.sellOrderId, status, ['MATCHED', 'SETTLING']);
    })();
  }

  /** Enqueues settlement for a freshly claimed match. Called by OrderService.onMatch. */
  handleMatch(match: Match): void {
    this.queue.enqueue(match.id, (attempt, maxAttempts) => this.attemptSettlement(match, attempt, maxAttempts));
  }

  private async attemptSettlement(match: Match, attempt: number, maxAttempts: number): Promise<'done' | 'retry'> {
    this.recordAttemptStart(match.id);
    if (attempt === 1) {
      this.broadcaster.broadcast('order.settling', { match });
    }

    const result = await this.settlementClient.settle({ id: match.buyOrderId }, { id: match.sellOrderId });

    if (result.outcome === 'success') {
      this.markOrdersTerminal(match, 'FILLED');
      this.recordOutcome(match.id, { status: 'SUCCESS', tx_id: result.txId });
      this.broadcaster.broadcast('order.filled', { match, txId: result.txId });
      return 'done';
    }

    // Recovery check: the call may have failed for a reason unrelated to
    // whether it actually landed (e.g. we lost the response after the chain
    // already applied it). If both orders are already FILLED on-chain, this
    // settlement did succeed — report that rather than FAILED.
    const [buyState, sellState] = await Promise.all([
      this.settlementClient.getOnChainState(match.buyOrderId),
      this.settlementClient.getOnChainState(match.sellOrderId),
    ]);

    if (buyState === 'FILLED' && sellState === 'FILLED') {
      this.markOrdersTerminal(match, 'FILLED');
      this.recordOutcome(match.id, { status: 'SUCCESS' });
      this.broadcaster.broadcast('order.filled', { match, txId: null });
      this.logger.info({ matchId: match.id }, 'settlement recovered: on-chain state was already FILLED despite a reported error');
      return 'done';
    }

    const bothStillOpen = buyState === 'OPEN' && sellState === 'OPEN';
    const isLastAttempt = attempt >= maxAttempts;

    if (bothStillOpen && !isLastAttempt) {
      this.recordOutcome(match.id, { status: 'PENDING', error: result.message });
      this.logger.warn({ matchId: match.id, attempt, maxAttempts, result }, 'settlement attempt failed transiently, will retry');
      return 'retry';
    }

    this.markOrdersTerminal(match, 'FAILED');
    this.recordOutcome(match.id, { status: 'FAILED', error: result.message });
    this.broadcaster.broadcast('order.failed', { match, reason: result.message });
    this.logger.error({ matchId: match.id, attempt, maxAttempts, result, buyState, sellState }, 'settlement failed permanently');
    return 'done';
  }

  /**
   * Re-enqueues any match whose orders were left MATCHED/SETTLING by a
   * previous process instance (SettlementQueue is in-memory only). Call
   * once at startup after all dependencies are wired — see src/index.ts.
   */
  recoverPendingSettlements(): number {
    const unsettled = this.matchRepo.listByOrderStatus(['MATCHED', 'SETTLING']);
    for (const match of unsettled) {
      this.logger.info({ matchId: match.id }, 'recovering in-flight settlement from a previous run');
      this.handleMatch(match);
    }
    return unsettled.length;
  }
}
