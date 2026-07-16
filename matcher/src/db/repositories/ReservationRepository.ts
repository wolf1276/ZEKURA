import type Database from 'better-sqlite3';

import type { PpmReservation, ReservationState } from '../../types/Treasury.js';

interface ReservationRow {
  quote_id: string;
  order_id: string | null;
  asset_key: string;
  amount: string;
  price: string;
  expires_at: string;
  state: string;
  created_at: number;
  updated_at: number;
}

function rowToReservation(row: ReservationRow): PpmReservation {
  return {
    quoteId: row.quote_id,
    orderId: row.order_id,
    assetKey: row.asset_key,
    amount: BigInt(row.amount),
    price: BigInt(row.price),
    expiresAt: BigInt(row.expires_at),
    state: row.state as ReservationState,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Local mirror of the contract's on-chain reservations Map — see schema.ts's comment on ppm_reservations. */
export class ReservationRepository {
  constructor(private readonly db: Database.Database) {}

  insert(reservation: PpmReservation): void {
    this.db
      .prepare(
        `INSERT INTO ppm_reservations
           (quote_id, order_id, asset_key, amount, price, expires_at, state, created_at, updated_at)
         VALUES (@quote_id, @order_id, @asset_key, @amount, @price, @expires_at, @state, @created_at, @updated_at)`,
      )
      .run({
        quote_id: reservation.quoteId,
        order_id: reservation.orderId,
        asset_key: reservation.assetKey,
        amount: reservation.amount.toString(),
        price: reservation.price.toString(),
        expires_at: reservation.expiresAt.toString(),
        state: reservation.state,
        created_at: reservation.createdAt,
        updated_at: reservation.updatedAt,
      });
  }

  findById(quoteId: string): PpmReservation | undefined {
    const row = this.db.prepare('SELECT * FROM ppm_reservations WHERE quote_id = ?').get(quoteId) as
      | ReservationRow
      | undefined;
    return row ? rowToReservation(row) : undefined;
  }

  /** OPEN reservations whose expiresAt has passed as of `nowSeconds` — the sweep behind PPMService's proactive releaseExpiredLiquidity pass. */
  listExpiredOpen(nowSeconds: bigint): PpmReservation[] {
    const rows = this.db
      .prepare("SELECT * FROM ppm_reservations WHERE state = 'OPEN' AND CAST(expires_at AS INTEGER) <= ?")
      .all(nowSeconds.toString()) as ReservationRow[];
    return rows.map(rowToReservation);
  }

  listByState(state: ReservationState): PpmReservation[] {
    const rows = this.db
      .prepare('SELECT * FROM ppm_reservations WHERE state = ? ORDER BY created_at ASC')
      .all(state) as ReservationRow[];
    return rows.map(rowToReservation);
  }

  /**
   * Compare-and-swap state transition — same shape as
   * OrderRepository.updateStatus's CAS guard, defense-in-depth alongside the
   * caller's own single-flight guarantee (see PPMService).
   */
  updateState(quoteId: string, newState: ReservationState, expectedCurrentStates?: readonly ReservationState[]): boolean {
    const updatedAt = Date.now();
    if (expectedCurrentStates && expectedCurrentStates.length > 0) {
      const placeholders = expectedCurrentStates.map(() => '?').join(', ');
      const result = this.db
        .prepare(`UPDATE ppm_reservations SET state = ?, updated_at = ? WHERE quote_id = ? AND state IN (${placeholders})`)
        .run(newState, updatedAt, quoteId, ...expectedCurrentStates);
      return result.changes === 1;
    }
    const result = this.db
      .prepare('UPDATE ppm_reservations SET state = ?, updated_at = ? WHERE quote_id = ?')
      .run(newState, updatedAt, quoteId);
    return result.changes === 1;
  }

  setOrderId(quoteId: string, orderId: string): boolean {
    const result = this.db
      .prepare('UPDATE ppm_reservations SET order_id = ?, updated_at = ? WHERE quote_id = ?')
      .run(orderId, Date.now(), quoteId);
    return result.changes === 1;
  }
}
