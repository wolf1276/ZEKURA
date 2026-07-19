import type Database from 'better-sqlite3';

import type { Match } from '../../matcher/Match.js';
import { assetKey } from '../../types/Asset.js';
import type { OrderStatus } from '../../types/Status.js';

interface MatchRow {
  id: string;
  buy_order_id: string;
  sell_order_id: string;
  asset_key: string;
  price: string;
  amount: string;
  matched_at: number;
}

// asset_key *is* the real asset color now (see types/Asset.ts) — no separate
// caller-supplied `asset` parameter needed to reconstruct a Match from a row
// anymore (previously the matches table only stored a one-way hash of the
// full asset tuple, so the caller had to already know the tuple to rebuild
// it; that indirection is gone along with deriveAssetKey).
function rowToMatch(row: MatchRow): Match {
  return {
    id: row.id,
    buyOrderId: row.buy_order_id,
    sellOrderId: row.sell_order_id,
    asset: row.asset_key,
    price: BigInt(row.price),
    amount: BigInt(row.amount),
    matchedAt: row.matched_at,
  };
}

export class MatchRepository {
  constructor(private readonly db: Database.Database) {}

  insert(match: Match): void {
    this.db
      .prepare(
        `INSERT INTO matches (id, buy_order_id, sell_order_id, asset_key, price, amount, matched_at)
         VALUES (@id, @buy_order_id, @sell_order_id, @asset_key, @price, @amount, @matched_at)`,
      )
      .run({
        id: match.id,
        buy_order_id: match.buyOrderId,
        sell_order_id: match.sellOrderId,
        asset_key: assetKey(match.asset),
        price: match.price.toString(),
        amount: match.amount.toString(),
        matched_at: match.matchedAt,
      });
  }

  findById(id: string): Match | undefined {
    const row = this.db.prepare('SELECT * FROM matches WHERE id = ?').get(id) as MatchRow | undefined;
    return row ? rowToMatch(row) : undefined;
  }

  findByOrderId(orderId: string): Match | undefined {
    const row = this.db
      .prepare('SELECT * FROM matches WHERE buy_order_id = ? OR sell_order_id = ? ORDER BY matched_at DESC LIMIT 1')
      .get(orderId, orderId) as MatchRow | undefined;
    return row ? rowToMatch(row) : undefined;
  }

  /** Most recent trades for one asset, newest first — the read path behind GET /trades. */
  listRecentByAssetKey(assetKeyValue: string, limit: number): Match[] {
    const rows = this.db
      .prepare('SELECT * FROM matches WHERE asset_key = ? ORDER BY matched_at DESC LIMIT ?')
      .all(assetKeyValue, limit) as MatchRow[];
    return rows.map(rowToMatch);
  }

  /** Trades for one asset at or after `sinceMs`, oldest first — the read path behind GET /stats's rolling window. */
  listSinceByAssetKey(assetKeyValue: string, sinceMs: number): Match[] {
    const rows = this.db
      .prepare('SELECT * FROM matches WHERE asset_key = ? AND matched_at >= ? ORDER BY matched_at ASC')
      .all(assetKeyValue, sinceMs) as MatchRow[];
    return rows.map(rowToMatch);
  }

  /**
   * Matches whose buy or sell order currently has one of `statuses` — used
   * at startup to re-enqueue settlements that were still in flight (order
   * status MATCHED/SETTLING) when the process last stopped, since the
   * SettlementQueue itself is purely in-memory. Still joins against `orders`
   * for the status filter itself, but no longer needs any asset columns from
   * it — matches.asset_key already holds the real asset value directly.
   */
  listByOrderStatus(statuses: readonly OrderStatus[]): Match[] {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT m.*
         FROM matches m
         JOIN orders o ON o.id = m.buy_order_id
         JOIN orders s ON s.id = m.sell_order_id
         WHERE o.status IN (${placeholders}) OR s.status IN (${placeholders})
         ORDER BY m.matched_at ASC`,
      )
      .all(...statuses, ...statuses) as MatchRow[];
    return rows.map(rowToMatch);
  }
}
