import type Database from 'better-sqlite3';

import type { Order } from '../../types/Order.js';
import type { OrderStatus } from '../../types/Status.js';

interface OrderRow {
  id: string;
  asset_key: string;
  side: string;
  price: string;
  amount: string;
  commitment: string;
  owner_id: string;
  signature: string;
  status: string;
  created_at: number;
  expires_at: string;
  payout_address: string | null;
}

function rowToOrder(row: OrderRow): Order {
  return {
    id: row.id,
    asset: row.asset_key,
    side: row.side as Order['side'],
    price: BigInt(row.price),
    amount: BigInt(row.amount),
    commitment: row.commitment,
    ownerId: row.owner_id,
    signature: row.signature,
    status: row.status as OrderStatus,
    createdAt: row.created_at,
    expiresAt: BigInt(row.expires_at),
    payoutAddress: row.payout_address,
  };
}

export class OrderRepository {
  constructor(private readonly db: Database.Database) {}

  /** Inserts a brand-new order as OPEN. Throws on duplicate id (SQLITE_CONSTRAINT). */
  insert(order: Order): void {
    this.db
      .prepare(
        `INSERT INTO orders
           (id, asset_key, side, price, amount,
            commitment, owner_id, signature, status, created_at, expires_at, payout_address)
         VALUES (@id, @asset_key, @side, @price, @amount,
                 @commitment, @owner_id, @signature, @status, @created_at, @expires_at, @payout_address)`,
      )
      .run({
        id: order.id,
        asset_key: order.asset,
        side: order.side,
        price: order.price.toString(),
        amount: order.amount.toString(),
        commitment: order.commitment,
        owner_id: order.ownerId,
        signature: order.signature,
        status: order.status,
        created_at: order.createdAt,
        expires_at: order.expiresAt.toString(),
        payout_address: order.payoutAddress ?? null,
      });
  }

  findById(id: string): Order | undefined {
    const row = this.db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as OrderRow | undefined;
    return row ? rowToOrder(row) : undefined;
  }

  exists(id: string): boolean {
    return this.db.prepare('SELECT 1 FROM orders WHERE id = ?').get(id) !== undefined;
  }

  listOpen(): Order[] {
    const rows = this.db
      .prepare("SELECT * FROM orders WHERE status = 'OPEN' ORDER BY created_at ASC")
      .all() as OrderRow[];
    return rows.map(rowToOrder);
  }

  listByStatus(status: OrderStatus): Order[] {
    const rows = this.db
      .prepare('SELECT * FROM orders WHERE status = ? ORDER BY created_at ASC')
      .all(status) as OrderRow[];
    return rows.map(rowToOrder);
  }

  /** OPEN orders for one asset (see types/Asset.ts's assetKey) — the read path behind GET /orderbook. Uses the same `idx_orders_asset`/`idx_orders_status` indexes as listOpen(). */
  listOpenByAssetKey(assetKey: string): Order[] {
    const rows = this.db
      .prepare("SELECT * FROM orders WHERE status = 'OPEN' AND asset_key = ? ORDER BY created_at ASC")
      .all(assetKey) as OrderRow[];
    return rows.map(rowToOrder);
  }

  /**
   * Compare-and-swap status transition: only applies if the order's current
   * status is one of `expectedCurrentStatuses` (when given). Returns true
   * iff the row was actually updated — defense-in-depth against the same
   * order being concurrently claimed twice, alongside the caller wrapping
   * this in a single synchronous db.transaction() (see services/OrderService.ts).
   */
  updateStatus(id: string, newStatus: OrderStatus, expectedCurrentStatuses?: readonly OrderStatus[]): boolean {
    if (expectedCurrentStatuses && expectedCurrentStatuses.length > 0) {
      const placeholders = expectedCurrentStatuses.map(() => '?').join(', ');
      const result = this.db
        .prepare(`UPDATE orders SET status = ? WHERE id = ? AND status IN (${placeholders})`)
        .run(newStatus, id, ...expectedCurrentStatuses);
      return result.changes === 1;
    }
    const result = this.db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(newStatus, id);
    return result.changes === 1;
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM orders WHERE id = ?').run(id);
    return result.changes === 1;
  }
}
