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

interface MatchRowWithAsset extends MatchRow {
  buy_asset_is_left: number;
  buy_asset_left: string;
  buy_asset_right: string;
}

function rowToMatch(row: MatchRow, asset: Match['asset']): Match {
  return {
    id: row.id,
    buyOrderId: row.buy_order_id,
    sellOrderId: row.sell_order_id,
    asset,
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

  /** Reads back a match. Requires `asset` since the matches table only stores the asset's partition key, not the full tuple. */
  findById(id: string, asset: Match['asset']): Match | undefined {
    const row = this.db.prepare('SELECT * FROM matches WHERE id = ?').get(id) as MatchRow | undefined;
    return row ? rowToMatch(row, asset) : undefined;
  }

  findByOrderId(orderId: string, asset: Match['asset']): Match | undefined {
    const row = this.db
      .prepare('SELECT * FROM matches WHERE buy_order_id = ? OR sell_order_id = ? ORDER BY matched_at DESC LIMIT 1')
      .get(orderId, orderId) as MatchRow | undefined;
    return row ? rowToMatch(row, asset) : undefined;
  }

  /**
   * Matches whose buy or sell order currently has one of `statuses` — used
   * at startup to re-enqueue settlements that were still in flight (order
   * status MATCHED/SETTLING) when the process last stopped, since the
   * SettlementQueue itself is purely in-memory. Joins against `orders` for
   * the buy side's asset tuple (the matches table only stores the asset's
   * partition key).
   */
  listByOrderStatus(statuses: readonly OrderStatus[]): Match[] {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT m.*, o.asset_is_left AS buy_asset_is_left, o.asset_left AS buy_asset_left, o.asset_right AS buy_asset_right
         FROM matches m
         JOIN orders o ON o.id = m.buy_order_id
         JOIN orders s ON s.id = m.sell_order_id
         WHERE o.status IN (${placeholders}) OR s.status IN (${placeholders})
         ORDER BY m.matched_at ASC`,
      )
      .all(...statuses, ...statuses) as MatchRowWithAsset[];
    return rows.map((row) =>
      rowToMatch(row, { isLeft: row.buy_asset_is_left === 1, left: row.buy_asset_left, right: row.buy_asset_right }),
    );
  }
}
