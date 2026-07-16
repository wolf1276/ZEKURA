import type Database from 'better-sqlite3';

import type { TreasuryEvent, TreasuryTxKind } from '../../types/Treasury.js';

interface TreasuryEventRow {
  id: string;
  kind: string;
  asset_key: string;
  amount: string;
  actor: string;
  tx_id: string | null;
  created_at: number;
}

function rowToEvent(row: TreasuryEventRow): TreasuryEvent {
  return {
    id: row.id,
    kind: row.kind as TreasuryTxKind,
    assetKey: row.asset_key,
    amount: BigInt(row.amount),
    actor: row.actor,
    txId: row.tx_id,
    createdAt: row.created_at,
  };
}

/** Persists the Matcher's local mirror of the contract's on-chain treasuryHistory Map — see schema.ts's comment on treasury_events. */
export class TreasuryRepository {
  constructor(private readonly db: Database.Database) {}

  insert(event: TreasuryEvent): void {
    this.db
      .prepare(
        `INSERT INTO treasury_events (id, kind, asset_key, amount, actor, tx_id, created_at)
         VALUES (@id, @kind, @asset_key, @amount, @actor, @tx_id, @created_at)`,
      )
      .run({
        id: event.id,
        kind: event.kind,
        asset_key: event.assetKey,
        amount: event.amount.toString(),
        actor: event.actor,
        tx_id: event.txId,
        created_at: event.createdAt,
      });
  }

  findById(id: string): TreasuryEvent | undefined {
    const row = this.db.prepare('SELECT * FROM treasury_events WHERE id = ?').get(id) as
      | TreasuryEventRow
      | undefined;
    return row ? rowToEvent(row) : undefined;
  }

  /** Most recent Treasury history rows, newest first — the read path behind GET /treasury/history. */
  listRecent(limit: number, kind?: TreasuryTxKind): TreasuryEvent[] {
    const rows = kind
      ? (this.db
          .prepare('SELECT * FROM treasury_events WHERE kind = ? ORDER BY created_at DESC LIMIT ?')
          .all(kind, limit) as TreasuryEventRow[])
      : (this.db
          .prepare('SELECT * FROM treasury_events ORDER BY created_at DESC LIMIT ?')
          .all(limit) as TreasuryEventRow[]);
    return rows.map(rowToEvent);
  }

  /** Recomputes current on-chain balance/reserved per asset from the local mirror — a fast local fallback alongside the authoritative on-chain read (see services/TreasuryService.ts). */
  sumByAssetKey(assetKey: string): { deposited: bigint; withdrawn: bigint } {
    const rows = this.db
      .prepare("SELECT kind, amount FROM treasury_events WHERE asset_key = ? AND kind IN ('DEPOSIT', 'WITHDRAW')")
      .all(assetKey) as Array<{ kind: string; amount: string }>;
    let deposited = 0n;
    let withdrawn = 0n;
    for (const row of rows) {
      if (row.kind === 'DEPOSIT') deposited += BigInt(row.amount);
      else withdrawn += BigInt(row.amount);
    }
    return { deposited, withdrawn };
  }
}
