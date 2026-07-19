import type Database from 'better-sqlite3';

/** Persists an admin-supplied bootstrap reference price for a virgin asset — see schema.ts's bootstrap_prices comment. */
export class BootstrapPriceRepository {
  constructor(private readonly db: Database.Database) {}

  /** Admin-only, and only meaningful before the asset's first real trade — callers must not invoke this once `clear` has ever fired for the asset (see api/admin.ts). */
  set(assetKey: string, price: bigint, now: number): void {
    this.db
      .prepare(
        `INSERT INTO bootstrap_prices (asset_key, price, created_at) VALUES (@asset_key, @price, @created_at)
         ON CONFLICT(asset_key) DO UPDATE SET price = excluded.price, created_at = excluded.created_at`,
      )
      .run({ asset_key: assetKey, price: price.toString(), created_at: now });
  }

  get(assetKey: string): bigint | null {
    const row = this.db.prepare('SELECT price FROM bootstrap_prices WHERE asset_key = ?').get(assetKey) as
      | { price: string }
      | undefined;
    return row ? BigInt(row.price) : null;
  }

  /** Retires the bootstrap price permanently once the asset has a real trade — see OrderService's matchRepo.insert call site. */
  clear(assetKey: string): void {
    this.db.prepare('DELETE FROM bootstrap_prices WHERE asset_key = ?').run(assetKey);
  }
}
